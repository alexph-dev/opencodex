/**
 * The `/api/models` row list and its projection into export models.
 *
 * Extracted from model-routes.ts so `/api/client-config` and the integration
 * routes read the SAME visible-model list. Two callers computing "which models
 * does this user actually have" independently is how the export and the toggle
 * would quietly disagree about what a client was told.
 *
 * Bodies are unchanged from their previous home; only `export` was added.
 */
import type { CatalogModel } from "../../codex/catalog";
import { createHash } from "node:crypto";
import {
  catalogModelSlug,
  filterCatalogVisibleModels,
  accountBoundNativeOpenAiSlugsBySelector,
  nativeDefaultReasoningEffort,
  NATIVE_OPENAI_MODELS,
  nativeInputModalities,
  nativeModelRows,
  nativeReasoningEfforts,
  uniqueCatalogModelsForPublicList,
  shouldIncludeAccountBoundNativeOpenAi,
} from "../../codex/catalog";
import type { ExportModel } from "../../clients/config-export";
import { providerContextCap } from "../../providers/context-cap";
import { isVisionReasoningEffort } from "../../reasoning-effort";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import type { OcxConfig } from "../../types";
import { ensureCodexEntitlementFreshness } from "../../codex/model-entitlements";
import { fetchAllModels } from "./shared";
import { initialModelSelectionPending } from "../../providers/initial-model-selection";
import { catalogFastRowEligible, fastRowId } from "../fast-row";
import { knownEffortRowIds } from "../effort-row";

/**
 * One row of the `/api/models` list. Routed rows spread a `CatalogModel`, so the shape is
 * that model plus the identity/visibility fields this boundary computes for every row
 * regardless of source. `disabled` is always present; the rest vary by row origin.
 */
export type ManagementModelRow = Partial<CatalogModel> & {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  initialSelectionPending?: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
  manualPricing?: boolean;
  fastRowAvailable?: boolean;
  displayNameOverride?: string;
  displayNameSource?: "operator" | "provider" | "fallback";
};

/** Resolve the exact text and source shown for one routed discovered model. */
export function effectiveManagementDisplayName(
  config: Pick<OcxConfig, "providers">,
  model: CatalogModel,
): Pick<ManagementModelRow, "displayName" | "displayNameOverride" | "displayNameSource"> {
  const provider = config.providers[model.provider];
  const configured = provider?.modelDisplayNames;
  if (configured && Object.hasOwn(configured, model.id)) {
    const displayName = configured[model.id]?.trim();
    if (displayName) {
      return { displayName, displayNameOverride: displayName, displayNameSource: "operator" };
    }
  }
  const providerDisplayName = model.displayName?.trim();
  if (providerDisplayName) return { displayName: providerDisplayName, displayNameSource: "provider" };
  return { displayName: catalogModelSlug(model), displayNameSource: "fallback" };
}

/**
 * The exact row list `/api/models` returns. Extracted so `/api/client-config` exports the
 * models the GUI's Models tab shows — including this function's `disabled` computation,
 * which the export core (src/clients/config-export.ts) deliberately does not perform.
 */
export async function listManagementModelRows(
  config: OcxConfig,
  options: { entitlementWaitMs?: number; models?: readonly CatalogModel[] } = {},
): Promise<ManagementModelRow[]> {
  /*
   * A supplied roster skips the gather, and that is the point rather than an optimization.
   * `fetchAllModels` reaches providers and can persist an initial model selection, which a
   * read-only caller must not do. Everything below this line is the projection — the disabled
   * computation, native and account-bound rows, custom rows and the public list — so a caller
   * that brings its own roster still sees exactly what a writer would, and the two cannot
   * disagree about the roster for any reason except the roster itself.
   */
  const models = options.models === undefined
    ? (await Promise.all([
      fetchAllModels(config),
      ensureCodexEntitlementFreshness(config, {
        waitMs: options.entitlementWaitMs ?? 3_000,
      }),
    ]))[0]
    : [...options.models];
  const disabled = new Set(config.disabledModels ?? []);
  // Native GPT passthrough rows lead (provider "openai", bare-slug namespaced ids): sourced
  // from the static supported set so a disabled model stays listed and re-enableable.
  const nativeRows = nativeModelRows(config).map(row => ({ ...row, metadataSlug: row.slug }));
  const accountNativeRows = shouldIncludeAccountBoundNativeOpenAi(config)
    ? [...accountBoundNativeOpenAiSlugsBySelector(config).entries()].flatMap(([selector, slugs]) =>
      slugs
        .filter(slug => !NATIVE_OPENAI_MODELS.includes(slug))
        .map(slug => ({
          slug: `${selector}/${slug}`,
          metadataSlug: slug,
          disabled: disabled.has(`${selector}/${slug}`) || disabled.has(slug),
          contextWindow: undefined,
          maxInputTokens: undefined,
          autoCompactTokenLimit: undefined,
        })))
    : [];
  const native: ManagementModelRow[] = [...nativeRows, ...accountNativeRows].map(row => {
    const reasoningEfforts = nativeReasoningEfforts(row.metadataSlug).filter(isVisionReasoningEffort);
    const defaultReasoningEffort = nativeDefaultReasoningEffort(row.metadataSlug);
    return {
      provider: "openai",
      id: row.slug,
      namespaced: row.slug,
      disabled: row.disabled,
      native: true,
      reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      inputModalities: nativeInputModalities(row.slug),
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
      // The input ceiling is a separate number from the window for GPT-5.6 (922k under
      // 1.05M). Dropping it here made /api/models describe a native row as if the whole
      // window were usable as input, which is the claim the measurement disproved.
      ...(row.maxInputTokens !== undefined ? { maxInputTokens: row.maxInputTokens } : {}),
      ...(row.autoCompactTokenLimit !== undefined
        ? { autoCompactTokenLimit: row.autoCompactTokenLimit }
        : {}),
    };
  });
  const customModels: ManagementModelRow[] = (config.customModels ?? []).map(cm => {
    const namespaced = routedSlug(cm.provider, cm.modelId);
    return {
      provider: cm.provider,
      id: cm.modelId,
      namespaced,
      disabled: [...disabled].some(stored => slugEquals(stored, cm.provider, cm.modelId)),
      custom: true,
      customId: cm.id,
      displayName: cm.displayName,
      ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
      ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
      // Stored override, not the inherited ladder: the edit dialog must show what the user
      // set (including an explicit empty "no reasoning" ladder), not what the provider row
      // happens to advertise today.
      ...(Array.isArray(cm.reasoningEfforts) ? { reasoningEfforts: [...cm.reasoningEfforts] } : {}),
      // The stored default rides along so a client reloading /api/models can restore the
      // full edit state; the GUI has no default-effort control today, but dropping it here
      // would make any future PUT-based edit lose it silently.
      ...(cm.defaultReasoningEffort ? { defaultReasoningEffort: cm.defaultReasoningEffort } : {}),
    };
  });
  const publicModels = uniqueCatalogModelsForPublicList(models);
  // Custom rows below are REBUILT from config.customModels rather than spread from a
  // CatalogModel, so every field gather computed for the same slug has to be carried across by
  // hand. Without this a custom model whose provider is out of credit would be the one row on
  // the page that never shows as inactive (#1711), because the gather-derived row it replaces
  // is dropped by the slug dedup below.
  const quotaInactiveByNamespaced = new Map(
    publicModels
      .filter(model => model.quotaInactiveReason !== undefined)
      .map(model => [catalogModelSlug(model), model.quotaInactiveReason!] as const),
  );
  const comboNamespaced = new Set(
    publicModels.filter(model => model.provider === "combo").map(catalogModelSlug),
  );
  const visibleCustomModels = customModels
    .filter(model => !comboNamespaced.has(model.namespaced))
    .map(model => {
      const quotaInactiveReason = quotaInactiveByNamespaced.get(model.namespaced);
      return quotaInactiveReason ? { ...model, quotaInactiveReason } : model;
    });
  // Custom metadata wins when a physical live/static row resolves to the same Codex-facing
  // slug, while a combo keeps the same precedence it has in routing and /v1/models.
  const customNamespaced = new Set(visibleCustomModels.map(c => c.namespaced));
  const dedupedRouted = publicModels.map((m): ManagementModelRow | null => {
    // Codex-facing slug (one "/", slug-codec); disabledModels compares tolerate both forms.
    const namespaced = catalogModelSlug(m);
    if (m.provider !== "combo" && customNamespaced.has(namespaced)) return null;
    const contextCap = providerContextCap(config, m.provider);
    const nativeAlias = m.provider === "combo" && m.nativeAlias === true;
    const displayName = effectiveManagementDisplayName(config, m);
    return {
      ...m,
      ...displayName,
      namespaced,
      disabled: [...disabled].some(stored => (
        (!nativeAlias && stored === namespaced) || slugEquals(stored, m.provider, m.id)
      )),
      ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
    };
  }).filter((row): row is ManagementModelRow => row !== null);
  // Manual OpenAI rows retain their routed selector but replace the bare dashboard row.
  // Account-qualified rows remain distinct, explicitly selected routes.
  const visibleNative = native.filter(model => model.id.includes("/")
    || !customNamespaced.has(routedSlug(model.provider, model.id)));
  const rows = [...visibleNative, ...dedupedRouted, ...visibleCustomModels];
  // Include disabled rows and configured aliases before the export visibility filter:
  // a hidden real `x--fast` must never become a synthetic selector for another model.
  const knownIds = config.fastRows === false ? new Set<string>() : knownEffortRowIds(config);
  for (const row of rows) knownIds.add(row.namespaced);
  return rows.map(row => {
    const pending = initialModelSelectionPending(config.providers[row.provider]);
    const modelCosts = Object.hasOwn(config.providers, row.provider)
      ? config.providers[row.provider]?.modelCosts : undefined;
    return {
      ...row,
      ...(!row.native && modelCosts !== undefined && Object.hasOwn(modelCosts, row.id)
        ? { manualPricing: true } : {}),
      ...(pending ? { disabled: true, initialSelectionPending: true } : {}),
      fastRowAvailable: !row.disabled && !pending
        && !knownIds.has(fastRowId(row.namespaced)) && catalogFastRowEligible(config, row),
    };
  });
}

/** `/api/models` row → the narrower input the client-config serializers accept. */
export function toExportModel(row: ManagementModelRow): ExportModel {
  return {
    namespaced: row.namespaced,
    provider: row.provider,
    id: row.id,
    fastRowAvailable: row.fastRowAvailable === true,
    ...(row.native ? { native: true } : {}),
    ...(row.displayName && row.displayNameSource !== "fallback" ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.reasoningEfforts ? { reasoningEfforts: row.reasoningEfforts } : {}),
    ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
  };
}

/**
 * Visible (non-disabled) rows as export models — the ONE loader both
 * `/api/client-config` and the integration routes use, so the two can never
 * disagree about which models a client is told about.
 *
 * The visibility filter lives HERE rather than at each call site: the export
 * core serializes what it is given, so a model the user disabled in the Models
 * tab is absent from `/v1/models` and exporting it would hand the client a
 * selector the proxy refuses to route.
 */
export async function loadExportModels(
  config: OcxConfig,
  models?: readonly CatalogModel[],
): Promise<ExportModel[]> {
  const rows = await listManagementModelRows(config, models === undefined ? {} : { models });
  // Management deliberately lists the full roster so hidden models can be enabled.
  // A client picker must also honor the provider selection, not just its blocklist.
  const visibleRouted = new Set(filterCatalogVisibleModels(rows.filter(row => !row.native), config));
  const exported = rows.filter(row => !row.disabled && (row.native || visibleRouted.has(row))).map(toExportModel);
  // Retain the FINAL projection, not an input to it. A preview that rebuilt from raw provider
  // caches would miss static and forward providers, which never populate one, and would skip the
  // retention, metadata, combo and filtering this function applies afterwards.
  lastExportSnapshot = {
    key: exportSnapshotKey(config),
    generation: ++exportSnapshotGeneration,
    models: Object.freeze([...exported]),
  };
  return exported;
}

/**
 * The completed export roster from the last ordinary load, if it still describes this config.
 *
 * A preview may not gather, so it reads only what an authoritative load already finished. The key
 * is a digest over the provider graph's shape, the blocklist and custom models, so changing any of
 * them retires the snapshot rather than letting a preview plan against a roster the user no longer
 * has. Credentials are not part of it and are never read here.
 *
 * A cold process has no snapshot, and the caller answers a bounded refusal until the ordinary
 * models path populates one. That is a real and recoverable state, unlike a read that gathers.
 */
let lastExportSnapshot: { key: string; generation: number; models: readonly ExportModel[] } | null = null;
let exportSnapshotGeneration = 0;

/**
 * Opaque identity of the snapshot a caller is holding, or null when there is none for this config.
 *
 * A fingerprint check that rebuilt its own roster could validate against one snapshot while the
 * mutation wrote from another, because an ordinary load can replace the snapshot at any moment and
 * nothing about that is serialised against the writer lock. Carrying this identity alongside the
 * captured roster lets a revalidation prove the snapshot it captured is still the current one
 * without ever swapping the roster the mutation is about to use.
 */
export function exportSnapshotIdentity(config: OcxConfig): string | null {
  const snapshot = lastExportSnapshot;
  if (snapshot === null || snapshot.key !== exportSnapshotKey(config)) return null;
  return `${snapshot.key}:${snapshot.generation}`;
}

function exportSnapshotKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers ?? {})
    .map(([name, provider]) => [name, provider.adapter, provider.baseUrl])
    .sort((left, right) => String(left[0]) < String(right[0]) ? -1 : 1);
  return createHash("sha256").update(JSON.stringify({
    providers,
    disabled: config.disabledModels ?? [],
    custom: config.customModels ?? [],
  })).digest("hex").slice(0, 32);
}

/** Test seam: a fresh process has no snapshot, and suites must be able to reproduce that. */
export function resetExportSnapshotForTests(): void {
  lastExportSnapshot = null;
}

/**
 * The export roster for a read that must change nothing at all, or null when there is not one.
 *
 * Skipping the initial-selection finalizer was not enough. Discovery itself refreshes credentials
 * and writes the provider model cache, so a preview that gathered would still be a write dressed
 * as a read, and "the models list already does this" describes what a GET happens to do rather
 * than what a preview is allowed to do.
 *
 * So this reads already-captured per-provider cache entries and never fetches. When no provider
 * has a cached roster there is no honest snapshot to plan against, and the caller reports a
 * bounded refusal rather than triggering a gather to manufacture one.
 */
export function previewExportSnapshot(
  config: OcxConfig,
): { models: readonly ExportModel[]; identity: string } | null {
  // One synchronous read of one const. Taking the roster and its identity in two steps let a
  // concurrent load publish a new snapshot between them, so a caller could hold one roster while
  // believing it held the identity of another.
  const snapshot = lastExportSnapshot;
  if (snapshot === null || snapshot.key !== exportSnapshotKey(config)) return null;
  return { models: snapshot.models, identity: `${snapshot.key}:${snapshot.generation}` };
}

export function previewExportModels(config: OcxConfig): readonly ExportModel[] | null {
  return previewExportSnapshot(config)?.models ?? null;
}
