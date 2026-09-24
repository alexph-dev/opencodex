import type { OcxConfig } from "../../types";
import { MODEL_ALIAS_PATTERN } from "../../providers/default-aliases";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers-destination";
import { resolveComboId } from "../../combos/identifiers";
import type { CatalogModel, RawEntry } from "./parsing";
import { NATIVE_MODEL_ALIAS_KIND } from "./kinds";
import {
  UPSTREAM_NATIVE_ENTRIES, nativeContextLimits, nativeInputModalities,
  nativeReasoningEfforts, nativeDefaultReasoningEffort, nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens, nativeOpenAiMaxOutputTokens, nativeOpenAiAutoCompactTokenLimit,
} from "./metadata";

/** Additive selector ownership, never the combo-native-alias bare-id takeover marker. */
export { NATIVE_MODEL_ALIAS_KIND } from "./kinds";
export const NATIVE_MODEL_ALIAS_SOURCE = "opencodex_native_alias_source";

/** Only the admitted canonical provider configuration can introduce these projections. */
export function gatherNativeModelAliases(config: OcxConfig): CatalogModel[] {
  const provider = config.providers.openai;
  if (!provider || provider.disabled || !isCanonicalOpenAiForwardProvider({ ...provider, authMode: provider.authMode ?? "forward" })) return [];
  // An exact account namespace has higher routing precedence than a provider selector.
  if (Object.hasOwn(config.codexAccountNamespaces ?? {}, "openai")) return [];
  const aliases = Object.entries(provider.modelAliases ?? {})
    .filter(([, alias]) => typeof alias === "string" && MODEL_ALIAS_PATTERN.test(alias));
  const known = new Set([
    ...UPSTREAM_NATIVE_ENTRIES.keys(), ...(provider.models ?? []), provider.defaultModel,
    ...(config.customModels ?? []).filter(row => row.provider === "openai").map(row => row.modelId),
  ]);
  const limits = nativeContextLimits(config);
  return aliases.flatMap(([id, alias]) => {
    if (!UPSTREAM_NATIVE_ENTRIES.has(id) || known.has(alias)
      // Catalog omission does not relinquish a configured combo's routing precedence.
      || resolveComboId(config, `openai/${alias}`) !== null
      || aliases.filter(([, candidate]) => candidate.toLowerCase() === alias.toLowerCase()).length !== 1
      || config.disabledModels?.includes(id)) return [];
    return [{
      provider: "openai", id, alias: `openai/${alias}`, displayName: alias,
      catalogKind: NATIVE_MODEL_ALIAS_KIND,
      contextWindow: nativeOpenAiContextWindow(id, limits),
      maxInputTokens: nativeOpenAiMaxInputTokens(id, limits),
      maxOutputTokens: nativeOpenAiMaxOutputTokens(id),
      autoCompactTokenLimit: nativeOpenAiAutoCompactTokenLimit(id, limits),
      inputModalities: nativeInputModalities(id), reasoningEfforts: nativeReasoningEfforts(id),
      defaultReasoningEffort: nativeDefaultReasoningEffort(id),
    }];
  });
}

/** Markers carry catalog provenance only; routing still resolves configured modelAliases. */
export function nativeModelAliasSource(entry: RawEntry): string | undefined {
  const source = entry[NATIVE_MODEL_ALIAS_SOURCE];
  return entry.opencodex_catalog_kind === NATIVE_MODEL_ALIAS_KIND
    && typeof entry.slug === "string" && entry.slug.startsWith("openai/")
    && typeof source === "string" && UPSTREAM_NATIVE_ENTRIES.has(source)
    ? source : undefined;
}

export function nativeModelAliasEntry(source: RawEntry, selection: RawEntry): RawEntry {
  const entry = structuredClone(source) as RawEntry;
  delete entry.opencodex_native_display_name;
  delete entry.opencodex_spawn_priority;
  entry.slug = selection.slug;
  entry.display_name = selection.display_name;
  entry.priority = selection.priority;
  entry.visibility = selection.visibility ?? "list";
  entry.opencodex_catalog_kind = NATIVE_MODEL_ALIAS_KIND;
  entry[NATIVE_MODEL_ALIAS_SOURCE] = source.slug;
  return entry;
}

/** Rebase fresh projections after native normalization, never from a persisted alias body. */
export function alignNativeModelAliases(
  entries: RawEntry[], fresh: ReadonlySet<RawEntry>,
  featured: readonly string[], disabled: ReadonlySet<string>,
): RawEntry[] {
  const freshSlugs = new Set([...fresh].map(row => row.slug));
  const sources = new Map(entries.filter(row => row.opencodex_catalog_kind !== NATIVE_MODEL_ALIAS_KIND
    && row.owned_by !== "combo" && typeof row.slug === "string" && !row.slug.includes("/"))
    .map(row => [row.slug, row]));
  const tailPriority = Math.max(0, ...entries.filter(row => row.opencodex_catalog_kind !== NATIVE_MODEL_ALIAS_KIND)
    .map(row => typeof row.priority === "number" ? row.priority : 0)) + 1;
  return entries.flatMap(row => {
    if (row.opencodex_catalog_kind !== NATIVE_MODEL_ALIAS_KIND) return [row];
    const sourceSlug = nativeModelAliasSource(row);
    const source = sourceSlug ? sources.get(sourceSlug) : undefined;
    if (!source || !freshSlugs.has(row.slug) || disabled.has(sourceSlug!)) return [];
    return [nativeModelAliasEntry(source, {
      ...row, priority: featured.includes(String(row.slug)) ? row.priority : tailPriority,
    })];
  });
}
