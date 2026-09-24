import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterCatalogVisibleModels, finalizeAutoReviewModelOverride, gatherRoutedModels, getLastComboCatalogOmissions, nativeContextLimits, resetCatalogRuntimeStateForTests, upstreamNativeEntry } from "../../src/codex/catalog";
import { clampCatalogModelsToObservedCodexSupport } from "../../src/codex/catalog/effort";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, type ObservedCatalogMergeInput } from "../../src/codex/catalog/sync";
import { routeModel, routeCompactionModel } from "../../src/router";
import { clearComboSelectionState, resolveComboId } from "../../src/combos";
import type { OcxConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetCatalogRuntimeStateForTests(); clearComboSelectionState(); });
const sourceModel = "gpt-6-astra";
const selector = "openai/Astra-Jev";
function config(alias = true): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100, defaultProvider: "openai",
    providers: { openai: {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "direct",
      ...(alias ? { modelAliases: { [sourceModel]: "Astra-Jev" } } : {}),
    } },
    customModels: [{ id: "ordinary-astra", provider: "openai", modelId: sourceModel, displayName: "Ordinary Astra" }],
  });
}
async function catalog(settings: OcxConfig, previous: Record<string, unknown>[] = [], overrides: Partial<ObservedCatalogMergeInput> = {}) {
  globalThis.fetch = (() => { throw new Error("unexpected outbound request"); }) as unknown as typeof fetch;
  const models = filterCatalogVisibleModels(await gatherRoutedModels(settings), settings);
  const common = {
    template: null, featured: [], wsEnabled: true, multiAgentMode: "default" as const,
    multiAgentV2Enabled: false, exactComboSlugs: new Set<string>(),
    openaiContextCap: nativeContextLimits(settings),
    ...overrides,
  };
  const built = buildCatalogEntriesFromObservedState({
    ...common, gptSlugs: [], goModels: models, accountSelectors: [],
    suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
  });
  return mergeCatalogEntriesFromObservedState({
    catalogModels: previous, baselineCatalogModels: [], routedEntries: built, baseline: new Map(),
    disabledModels: new Set(settings.disabledModels ?? []),
    selectedModelsByProvider: new Map(Object.entries(settings.providers).flatMap(([key, provider]) =>
      provider.selectedModels?.length ? [[key, new Set(provider.selectedModels)]] : [])),
    gatheredProviderNames: new Set(Object.keys(settings.providers)), degradedProviderNames: new Set(),
    legacyCustomModelSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
    accountBoundEntries: [], policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
    ...common,
  });
}
function capabilityFields(row: Record<string, unknown>) {
  const copy = structuredClone(row);
  for (const key of ["slug", "display_name", "description", "priority", "visibility", "opencodex_catalog_kind", "opencodex_native_alias_source"]) delete copy[key];
  return copy;
}

/** Exercise the same post-merge policy order as both production catalog writers. */
async function finalizedCatalog(settings: OcxConfig, previous: Record<string, unknown>[] = []) {
  const entries = await catalog(settings, previous);
  clampCatalogModelsToObservedCodexSupport(entries, new Set(["low", "medium", "high", "xhigh", "max", "ultra"]));
  const result = finalizeAutoReviewModelOverride(entries, previous, settings);
  return { entries, result };
}

async function withRootReviewer(run: (set: (reviewer: string | null) => void) => Promise<void>) {
  const previousHome = process.env.CODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "native-alias-review-"));
  process.env.CODEX_HOME = home;
  const set = (reviewer: string | null) => writeFileSync(join(home, "config.toml"),
    reviewer === null ? "" : `auto_review_model = ${JSON.stringify(reviewer)}\n`);
  try { set(null); await run(set); }
  finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
}

for (const providerPolicy of [false, true]) {
  test.each(["single", "distinct"])(`finalization preserves %s native reviewers with provider policy=${providerPolicy}`, async shape => {
    await withRootReviewer(async () => {
      const settings = config();
      delete settings.customModels;
      if (providerPolicy) settings.providers.gateway = {
        adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", liveModels: false,
        models: ["sample"], autoReviewModel: "gpt-5.6-sol",
      };
      const source = [{ ...upstreamNativeEntry(sourceModel), auto_review_model_override: "gpt-5.6-sol" },
        ...(shape === "distinct" ? [{ ...upstreamNativeEntry("gpt-5.6-sol"), auto_review_model_override: "gpt-5.6-luna" }] : [])];
      const sourceBefore = JSON.stringify(source);
      const ordinarySettings = { ...settings, providers: { ...settings.providers,
        openai: { ...settings.providers.openai, modelAliases: undefined } } };
      const ordinary = await finalizedCatalog(ordinarySettings, source);
      const added = await finalizedCatalog(settings, source);
      expect(ordinary.entries.find(row => row.slug === sourceModel)?.auto_review_model_override).toBe("gpt-5.6-sol");
      expect(added.result).toBe(ordinary.result);
      expect(added.entries.filter(row => row.slug !== selector)).toEqual(ordinary.entries);
      expect(capabilityFields(added.entries.find(row => row.slug === selector)!))
        .toEqual(capabilityFields(added.entries.find(row => row.slug === sourceModel)!));
      expect(JSON.stringify(source)).toBe(sourceBefore);
    });
  });
}

test.each(["Astra-Jev", sourceModel])("finalization preserves the ordinary custom reviewer keyed by %s", async key => {
  await withRootReviewer(async () => {
    const settings = config();
    settings.providers.openai.autoReviewModelOverrides = { [key]: "gpt-5.6-sol" };
    const beforeConfig = JSON.stringify(settings);
    // Same configured alias and ordinary custom row, before independent alias publication.
    // Removing the map entry instead would stop exercising the existing alias-key contract.
    const ordinary = (await catalog(settings)).filter(row => row.slug !== selector);
    clampCatalogModelsToObservedCodexSupport(ordinary, new Set(["low", "medium", "high", "xhigh", "max", "ultra"]));
    expect(finalizeAutoReviewModelOverride(ordinary, [], settings)).toBe("applied");
    expect(ordinary.find(row => row.slug === `openai/${sourceModel}`)?.auto_review_model_override).toBe("gpt-5.6-sol");

    const added = await finalizedCatalog(settings);
    expect(added.result).toBe("applied");
    expect(added.entries.find(row => row.slug === `openai/${sourceModel}`)?.auto_review_model_override).toBe("gpt-5.6-sol");
    expect(added.entries.filter(row => row.slug !== selector)).toEqual(ordinary);
    expect(capabilityFields(added.entries.find(row => row.slug === selector)!))
      .toEqual(capabilityFields(added.entries.find(row => row.slug === sourceModel)!));
    const repeated = await finalizedCatalog(settings, added.entries);
    expect(repeated).toEqual(added);
    expect(await finalizedCatalog(settings, repeated.entries)).toEqual(repeated);
    expect(JSON.stringify(settings)).toBe(beforeConfig);
  });
});

test.each(["Astra-Jev", sourceModel])("an actual competing model keeps reviewer key %s unpropagated", async key => {
  await withRootReviewer(async () => {
    const settings = config();
    settings.customModels!.push({ id: "competing-model", provider: "openai", modelId: "Astra-Jev", displayName: "Actual competing model" });
    settings.providers.openai.autoReviewModelOverrides = { [key]: "gpt-5.6-sol" };
    const before = JSON.stringify(settings);
    const published = await finalizedCatalog(settings);
    const competitor = published.entries.find(row => row.slug === selector)!;
    const ordinary = published.entries.find(row => row.slug === `openai/${sourceModel}`)!;
    expect(published.result).toBe("applied");
    expect(competitor.opencodex_catalog_kind).toBe("custom-model-v1");
    expect(competitor.display_name).toBe("Actual competing model");
    expect(competitor.auto_review_model_override).toBe(key === "Astra-Jev" ? "gpt-5.6-sol" : null);
    expect(ordinary.auto_review_model_override).toBe(key === sourceModel ? "gpt-5.6-sol" : null);
    expect(routeModel(settings, selector).modelId).toBe("Astra-Jev");
    expect(await finalizedCatalog(settings, published.entries)).toEqual(published);
    expect(JSON.stringify(settings)).toBe(before);
  });
});

test.each(["different native source", "missing source", "non-alias ownership"])("reviewer-key collision still applies with %s", async kind => {
  await withRootReviewer(async () => {
    const settings = config();
    settings.providers.openai.autoReviewModelOverrides = { "Astra-Jev": "gpt-5.6-sol" };
    const entries = await catalog(settings);
    const candidate = entries.find(row => row.slug === selector)!;
    // Exercise the finalizer's collision boundary with a competing/stale projection.
    // A marker by itself, or a projection of a different native model, is not the exemption.
    if (kind === "different native source") candidate.opencodex_native_alias_source = "gpt-5.6-sol";
    else if (kind === "missing source") delete candidate.opencodex_native_alias_source;
    else candidate.opencodex_catalog_kind = "custom-model-v1";
    const ordinary = entries.find(row => row.slug === `openai/${sourceModel}`)!;
    const before = structuredClone(ordinary);
    expect(finalizeAutoReviewModelOverride(entries, [], settings)).toBe("applied");
    expect(ordinary.auto_review_model_override).toBeNull();
    expect(ordinary).toEqual(before);
    if (kind === "different native source") {
      expect(candidate.auto_review_model_override)
        .toBe(entries.find(row => row.slug === "gpt-5.6-sol")!.auto_review_model_override);
    } else expect(candidate.auto_review_model_override).toBe("gpt-5.6-sol");
  });
});

test("retained alias evidence cannot clear a native reviewer on removal or poison the next refresh", async () => {
  await withRootReviewer(async () => {
    const settings = config(); delete settings.customModels;
    const original = [{ ...upstreamNativeEntry(sourceModel), auto_review_model_override: "gpt-5.6-sol" }];
    const ordinarySettings = { ...settings, providers: { openai: { ...settings.providers.openai, modelAliases: undefined } } };
    const ordinary = await finalizedCatalog(ordinarySettings, original);
    // R1 merge output, before auto-review finalization, is a real persisted-evidence shape.
    const retained = await catalog(settings, original);
    const removed = await finalizedCatalog(ordinarySettings, retained);
    expect(removed.entries).toEqual(ordinary.entries);
    const staleAlias = retained.find(row => row.slug === selector)!;
    staleAlias.auto_review_model_override = "gpt-5.6-luna";
    const before = JSON.stringify(retained);
    const refreshed = await finalizedCatalog(settings, retained);
    expect(refreshed.entries.filter(row => row.slug !== selector)).toEqual(ordinary.entries);
    expect(capabilityFields(refreshed.entries.find(row => row.slug === selector)!))
      .toEqual(capabilityFields(refreshed.entries.find(row => row.slug === sourceModel)!));
    expect((await finalizedCatalog(settings, refreshed.entries)).entries).toEqual(refreshed.entries);
    expect(JSON.stringify(retained)).toBe(before);
  });
});

test.each(["gpt-5.6-luna", selector])("root reviewer %s applies and restores native provenance after removal", async reviewer => {
  await withRootReviewer(async set => {
    const settings = config(); delete settings.customModels;
    const original = [{ ...upstreamNativeEntry(sourceModel), auto_review_model_override: "gpt-5.6-sol" }];
    set(reviewer);
    const applied = await finalizedCatalog(settings, original);
    expect(applied.result).toBe("applied");
    const alias = applied.entries.find(row => row.slug === selector)!;
    const native = applied.entries.find(row => row.slug === sourceModel)!;
    expect(native.auto_review_model_override).toBe(reviewer);
    expect(native.opencodex_auto_review_root).toEqual({ slug: sourceModel, original: "gpt-5.6-sol", applied: reviewer });
    expect(capabilityFields(alias)).toEqual(capabilityFields(native));
    expect(alias.opencodex_auto_review_root).not.toBe(native.opencodex_auto_review_root);
    expect((await finalizedCatalog(settings, applied.entries)).entries).toEqual(applied.entries);
    set(null);
    const removed = await finalizedCatalog(settings, applied.entries);
    expect(removed.result).toBe("absent");
    expect(removed.entries.find(row => row.slug === sourceModel)?.auto_review_model_override).toBe("gpt-5.6-sol");
    expect(capabilityFields(removed.entries.find(row => row.slug === selector)!))
      .toEqual(capabilityFields(removed.entries.find(row => row.slug === sourceModel)!));
    expect((await finalizedCatalog(settings, removed.entries)).entries).toEqual(removed.entries);
  });
});

test("retained alias markers cannot suppress genuine legacy-root cleanup", async () => {
  await withRootReviewer(async () => {
    const settings = config(); delete settings.customModels;
    const legacy = [{ ...upstreamNativeEntry(sourceModel), auto_review_model_override: "gpt-5.6-sol" },
      { slug: "gateway/sample", auto_review_model_override: "gpt-5.6-sol" }];
    const retainedAlias = { ...legacy[0], slug: selector,
      opencodex_catalog_kind: "native-model-alias-v1", opencodex_native_alias_source: sourceModel,
      auto_review_model_override: "gpt-5.6-luna", opencodex_auto_review_root: true };
    const ordinary = await finalizedCatalog(settings, legacy);
    const withRetained = await finalizedCatalog(settings, [...legacy, retainedAlias]);
    expect(ordinary.entries.find(row => row.slug === sourceModel)?.auto_review_model_override).toBeNull();
    expect(withRetained.entries).toEqual(ordinary.entries);
  });
});

test("an explicit native alias adds an independent picker row with exact native metadata", async () => {
  const settings = config();
  const beforeConfig = JSON.stringify(settings);
  const beforeSource = JSON.stringify(upstreamNativeEntry(sourceModel));
  const original = await catalog(config(false));
  const added = await catalog(settings, original);
  const alias = added.find(row => row.slug === selector);
  expect(alias).toBeDefined();
  expect(alias?.display_name).toBe("Astra-Jev");
  const native = added.find(row => row.slug === sourceModel)!;
  expect(capabilityFields(alias!)).toEqual(capabilityFields(native));
  expect(added.filter(row => row.slug !== selector)).toEqual(original);
  expect(added).toHaveLength(original.length + 1);
  expect(JSON.stringify(settings)).toBe(beforeConfig);
  expect(JSON.stringify(upstreamNativeEntry(sourceModel))).toBe(beforeSource);
  expect(await catalog(settings, added)).toEqual(added);
});

test("the documented cold configuration needs no custom model and survives final catalog policy", async () => {
  for (const authMode of [undefined, "forward"] as const) {
    const settings = config();
    delete settings.customModels;
    settings.providers.openai.authMode = authMode;
    settings.providers.openai.codexAccountMode = "pool";
    const entries = await catalog(settings);
    clampCatalogModelsToObservedCodexSupport(entries, new Set(["low", "medium", "high", "xhigh", "max", "ultra"]));
    finalizeAutoReviewModelOverride(entries, [], settings);
    const alias = entries.find(row => row.slug === selector)!;
    const native = entries.find(row => row.slug === sourceModel)!;
    expect(alias.display_name).toBe("Astra-Jev");
    expect(capabilityFields(alias)).toEqual(capabilityFields(native));
    expect(entries.some(row => row.slug === `openai/${sourceModel}`)).toBe(false);
    const route = routeModel(settings, selector);
    expect(route.modelId).toBe(sourceModel);
    expect(route.provider).toEqual(routeModel(settings, sourceModel).provider);
    expect(route.codexAccountMode).toBe("pool");
  }
});

test("adding an alias does not replace a pre-existing foreign catalog row at that selector", async () => {
  const foreign = { ...upstreamNativeEntry(sourceModel), slug: selector, display_name: "User-owned row", description: "Foreign catalog row" };
  const degradedProviderNames = new Set(["openai"]);
  const original = await catalog(config(false), [foreign], { degradedProviderNames });
  expect(original.find(row => row.slug === selector)?.display_name).toBe("User-owned row");
  expect(await catalog(config(), original, { degradedProviderNames })).toEqual(original);
});

test("removing the configured alias removes only its generated row", async () => {
  const original = await catalog(config(false));
  const added = await catalog(config(), original);
  expect(await catalog(config(false), added)).toEqual(original);
});

test.each(["enabled", "disabled"])("native metadata remains exact with WebSocket support %s", async state => {
  const wsEnabled = state === "enabled";
  for (const multiAgentMode of ["default", "v1", "v2"] as const) {
    const entries = await catalog(config(), [], { wsEnabled, multiAgentMode, keepNativeChatGptOnV1: true, multiAgentV2Enabled: true });
    expect(capabilityFields(entries.find(row => row.slug === selector)!))
      .toEqual(capabilityFields(entries.find(row => row.slug === sourceModel)!));
  }
});

test("final native instructions, unknown metadata and context policy remain the source", async () => {
  const native: Record<string, unknown> = {
    ...upstreamNativeEntry(sourceModel),
    future_native_support: { enabled: true, limits: [17, 23] },
  };
  const entries = await catalog(config(), [native], { openaiContextCap: { modelWindows: { [sourceModel]: 160_000 } } });
  const ordinary = entries.find(row => row.slug === sourceModel)!;
  expect(ordinary.base_instructions).toBe(native.base_instructions);
  expect(ordinary.future_native_support).toEqual(native.future_native_support);
  expect(capabilityFields(entries.find(row => row.slug === selector)!)).toEqual(capabilityFields(ordinary));
});

test("alias selection is not the default and does not inherit a featured native slot", async () => {
  const entries = await catalog(config(), [], { featured: [sourceModel] });
  const alias = entries.find(row => row.slug === selector)!;
  const ordinary = entries.find(row => row.slug === sourceModel)!;
  expect(ordinary.priority).toBe(0);
  expect(alias.priority).toBeGreaterThan(Math.max(...entries.filter(row => row.slug !== selector).map(row => Number(row.priority))));
});

test("selected source allowlists and explicit source/alias hiding apply without touching other rows", async () => {
  const settings = config();
  settings.providers.openai.selectedModels = [sourceModel];
  expect((await catalog(settings)).some(row => row.slug === selector)).toBe(true);
  settings.disabledModels = [sourceModel];
  expect((await catalog(settings)).some(row => row.slug === selector)).toBe(false);
  settings.disabledModels = [selector];
  expect((await catalog(settings)).some(row => row.slug === selector)).toBe(false);
  expect((await catalog(settings)).find(row => row.slug === sourceModel)?.visibility).toBe("list");
});

test.each([
  ["key authentication", { authMode: "key" }],
  ["noncanonical URL", { baseUrl: "https://gateway.example.test/v1" }],
  ["chat adapter", { adapter: "openai-chat" }],
  ["disabled provider", { disabled: true }],
] as const)("no native alias for %s", async (_label, override) => {
  const settings = config();
  Object.assign(settings.providers.openai, { liveModels: false, models: [sourceModel], apiKey: "fixture" }, override);
  expect((await catalog(settings)).some(row => row.slug === selector)).toBe(false);
});

test("unknown source, known-id collision and duplicate aliases cannot publish a native projection", async () => {
  const cases: Array<Record<string, string>> = [
    { unknown: "Astra-Jev" },
    { [sourceModel]: "gpt-5.6-sol" },
    { [sourceModel]: "Astra-Jev", "gpt-5.6-sol": "astra-jev" },
  ];
  for (const aliases of cases) {
    const settings = config(); settings.providers.openai.modelAliases = aliases;
    expect((await catalog(settings)).some(row => row.opencodex_catalog_kind === "native-model-alias-v1")).toBe(false);
  }
});

test.each(["incompatible_modalities", "incomplete_metadata"])("a combo omitted for %s still owns its complete selector", async reason => {
  const settings = config();
  settings.customModels = [
    { id: "sol-member", provider: "openai", modelId: "gpt-5.6-sol", inputModalities: ["image"] },
    { id: "astra-member", provider: "openai", modelId: sourceModel, inputModalities: ["text"] },
  ];
  settings.combos = { existing: { alias: selector, strategy: "failover", targets: [
    { provider: "openai", model: "gpt-5.6-sol" },
    { provider: reason === "incomplete_metadata" ? "unconfigured" : "openai", model: sourceModel },
  ] } };
  globalThis.fetch = (() => { throw new Error("unexpected outbound request"); }) as unknown as typeof fetch;
  const gathered = await gatherRoutedModels(settings);
  const omission = getLastComboCatalogOmissions().find(row => row.id === "existing");
  const published = await finalizedCatalog(settings);
  expect(omission?.reason).toBe(reason);
  expect(gathered.some(row => row.provider === "combo" && row.id === "existing")).toBe(false);
  expect(resolveComboId(settings, selector)).toBe("existing");
  for (const route of [routeModel(settings, selector), routeCompactionModel(settings, selector)]) {
    expect(route.routeKind).toBe("combo");
    expect(route.combo?.comboId).toBe("existing");
    expect(route.modelId).toBe("gpt-5.6-sol");
  }
  expect(routeModel(settings, sourceModel).modelId).toBe(sourceModel);
  expect(gathered.some(row => row.alias === selector && row.catalogKind === "native-model-alias-v1")).toBe(false);
  expect(published.entries.some(row => row.slug === selector)).toBe(false);
  delete settings.combos;
  expect((await finalizedCatalog(settings)).entries.find(row => row.slug === selector)?.display_name).toBe("Astra-Jev");
  expect(routeModel(settings, selector).modelId).toBe(sourceModel);
});

test.each(["Astra-Jev", "openai/astra-jev"])("a combo named %s does not own the distinct complete selector", async comboAlias => {
  const settings = config();
  settings.combos = { other: { alias: comboAlias, targets: [{ provider: "openai", model: "gpt-5.6-sol" }] } };
  expect(resolveComboId(settings, selector)).toBeNull();
  const entries = (await finalizedCatalog(settings)).entries;
  expect(entries.find(row => row.slug === selector)?.display_name).toBe("Astra-Jev");
  expect(routeModel(settings, selector).modelId).toBe(sourceModel);
  expect(routeModel(settings, comboAlias).combo?.comboId).toBe("other");
});

test.each(["alias", "destination"])("a gather captures native alias %s before yielding", async mutation => {
  const settings = config();
  const pending = gatherRoutedModels(settings);
  if (mutation === "alias") settings.providers.openai.modelAliases = { [sourceModel]: "Changed" };
  else settings.providers.openai.authMode = "key";
  const gathered = await pending;
  expect(gathered.find(row => row.alias === selector)?.id).toBe(sourceModel);
  expect(gathered.some(row => row.alias === "openai/Changed")).toBe(false);
});

test("malformed alias values do not create a projection or crash native discovery", async () => {
  const settings = config();
  settings.providers.openai.modelAliases = { [sourceModel]: null } as unknown as Record<string, string>;
  expect((await catalog(settings)).some(row => row.opencodex_catalog_kind === "native-model-alias-v1")).toBe(false);
});

test("alias and compact routes resolve the same canonical destination without changing ordinary routing", () => {
  const settings = config();
  const before = JSON.stringify(settings);
  const baseline = routeModel(settings, sourceModel);
  for (const route of [routeModel(settings, selector), routeModel(settings, "openai/astra-jev"), routeCompactionModel(settings, selector)]) {
    expect(route.modelId).toBe(sourceModel);
    expect(route.providerName).toBe("openai");
    expect(route.provider).toEqual(baseline.provider);
    // 2.59 resolves policy on the provider itself; it has no separate staticPolicy snapshot.
    expect(route.routeDecision?.selected).toMatchObject({ provider: baseline.providerName, model: baseline.modelId });
    expect(route.codexAccountMode).toBe(baseline.codexAccountMode);
  }
  for (const selection of [sourceModel, `openai/${sourceModel}`, "gpt-5.6-sol"]) {
    const actual = routeModel(settings, selection);
    const original = routeModel(config(false), selection);
    expect(actual.modelId).toBe(original.modelId);
    expect(actual.providerName).toBe(original.providerName);
    expect(actual.codexAccountMode).toBe(original.codexAccountMode);
    const provider = { ...actual.provider }; delete provider.modelAliases;
    expect(provider).toEqual(original.provider);
    expect(actual.routeDecision?.selected).toEqual(original.routeDecision?.selected);
  }
  expect(JSON.stringify(settings)).toBe(before);
});
