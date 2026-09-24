/** Request-local adaptive effort state. Never a provider, stored configuration or journal. */
export const ASTRA_JEV_SELECTOR = "openai/Astra-Jev";
export const ASTRA_JEV_NATIVE_MODEL = "gpt-6-astra";
export const ASTRA_JEV_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type AstraJevEffort = typeof ASTRA_JEV_EFFORTS[number];
export type AstraJevBaseline = AstraJevEffort | "unset" | "unsupported";
const ASTRA_JEV_REASONS = ["selected", "constrained", "disabled", "unvalidated_alias",
  "route_changed", "warmup", "compaction", "configuration_update", "opaque_ancestry",
  "incomplete_context", "unsupported_item", "non_text_context", "context_budget",
  "no_public_goal", "unsupported_ladder", "credential_unavailable", "timeout",
  "network", "http_error", "response_too_large", "invalid_response", "cancelled",
  "sampled_downshift_veto", "sampled_baseline_unknown", "withheld_media_downshift_veto",
  "withheld_media_baseline_unknown", "referenced_downshift_veto", "referenced_baseline_unknown",
  "invalid_usage", "provider_token_budget"] as const;
export type AstraJevReason = typeof ASTRA_JEV_REASONS[number];

const BUDGET_OWNERS = ["inspection_items", "inspection_text", "inspection_projection",
  "required_items", "required_state", "state", "request", "provider_tokens"] as const;
export type AstraJevBudgetOwner = typeof BUDGET_OWNERS[number];

/** Flat numeric/enum observations only. No caller state, content hashes or durable schema. */
export interface AstraJevMeasurements {
  protectedBytes: number | null;
  stateBytes: number | null;
  requestBytes: number | null;
  omittedItems: number | null;
  omittedProtectedMessages: number | null;
  omittedProtectedBytes: number | null;
  repeatedMessages: number | null;
  withheldMediaItems: number | null;
  selectionMode: "full" | "referenced" | "withheld" | "sampled" | "unavailable";
  budgetOwner: AstraJevBudgetOwner | null;
  providerInputTokens: number | null;
  evaluatorModel: string | null;
  preprocessingMs: number;
}

export function newAstraJevMeasurements(): AstraJevMeasurements {
  return { protectedBytes: null, stateBytes: null, requestBytes: null, omittedItems: null,
    omittedProtectedMessages: null, omittedProtectedBytes: null, repeatedMessages: null,
    withheldMediaItems: null,
    selectionMode: "unavailable", budgetOwner: null, providerInputTokens: null,
    evaluatorModel: null, preprocessingMs: 0 };
}

export function isAstraJevModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^jev-\d+\.\d+\.\d+$/.test(value);
}

export interface AstraJevDiagnostic extends Partial<AstraJevMeasurements> {
  selectedAlias: typeof ASTRA_JEV_SELECTOR;
  requestedBaseline: AstraJevBaseline;
  evaluatorChoice: AstraJevEffort | null;
  finalEffort: AstraJevBaseline | null;
  status: "applied" | "skipped" | "failed" | "cancelled";
  reason: AstraJevReason;
  evaluationMs: number;
}

export interface AstraJevPublicContext {
  source_instructions: string;
  history: Array<Record<string, unknown>>;
  omissions: string[];
}
export type AstraJevContextResult = {
  context: AstraJevPublicContext;
  /** Internal selection provenance, not caller data or evaluator instructions.
   * Only new whole-history selection sets it; legacy privacy/tool bounds do not.
   */
  sampled?: true;
  referenced?: true;
  withheldMedia?: true;
}
  | { reason: AstraJevReason };

export interface AstraJevInvocation {
  /** Captured before route rewriting or private-payload recovery. */
  selected: boolean;
  context?: AstraJevContextResult;
  requestedBaseline: AstraJevBaseline;
  decision?: Promise<AstraJevDiagnostic>;
  measurements?: AstraJevMeasurements;
}

export function astraJevBaseline(value: unknown): AstraJevBaseline {
  return value === undefined ? "unset"
    : typeof value === "string" && (ASTRA_JEV_EFFORTS as readonly string[]).includes(value)
      ? value as AstraJevEffort : "unsupported";
}

/** Closed logging projection: discard extra properties and never retain caller-owned objects. */
export function astraJevLogDiagnostic(value: unknown, cancelled = false): AstraJevDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const efforts: readonly unknown[] = ASTRA_JEV_EFFORTS;
  const baselines: readonly unknown[] = [...ASTRA_JEV_EFFORTS, "unset", "unsupported"];
  if (raw.selectedAlias !== ASTRA_JEV_SELECTOR || !baselines.includes(raw.requestedBaseline)
    || (raw.evaluatorChoice !== null && !efforts.includes(raw.evaluatorChoice))
    || (raw.finalEffort !== null && !baselines.includes(raw.finalEffort))
    || typeof raw.status !== "string" || !["applied", "skipped", "failed", "cancelled"].includes(raw.status)
    || !(ASTRA_JEV_REASONS as readonly unknown[]).includes(raw.reason)
    || typeof raw.evaluationMs !== "number" || !Number.isFinite(raw.evaluationMs) || raw.evaluationMs < 0) return undefined;
  const measured: Partial<AstraJevMeasurements> = {};
  for (const key of ["protectedBytes", "stateBytes", "requestBytes", "omittedItems",
    "omittedProtectedMessages", "omittedProtectedBytes", "repeatedMessages", "withheldMediaItems",
    "providerInputTokens"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return undefined;
    measured[key] = value as number | null;
  }
  if (Object.hasOwn(raw, "preprocessingMs")) {
    if (typeof raw.preprocessingMs !== "number" || !Number.isFinite(raw.preprocessingMs) || raw.preprocessingMs < 0) return undefined;
    measured.preprocessingMs = raw.preprocessingMs;
  }
  if (Object.hasOwn(raw, "selectionMode")) {
    if (typeof raw.selectionMode !== "string" || !["full", "referenced", "withheld", "sampled", "unavailable"].includes(raw.selectionMode)) return undefined;
    measured.selectionMode = raw.selectionMode as AstraJevMeasurements["selectionMode"];
  }
  if (Object.hasOwn(raw, "budgetOwner")) {
    if (raw.budgetOwner !== null && !(BUDGET_OWNERS as readonly unknown[]).includes(raw.budgetOwner)) return undefined;
    measured.budgetOwner = raw.budgetOwner as AstraJevBudgetOwner | null;
  }
  if (Object.hasOwn(raw, "evaluatorModel")) {
    if (raw.evaluatorModel !== null && !isAstraJevModel(raw.evaluatorModel)) return undefined;
    measured.evaluatorModel = raw.evaluatorModel as string | null;
  }
  return { ...measured, selectedAlias: ASTRA_JEV_SELECTOR, requestedBaseline: raw.requestedBaseline as AstraJevBaseline,
    evaluatorChoice: raw.evaluatorChoice as AstraJevEffort | null, finalEffort: raw.finalEffort as AstraJevBaseline | null,
    status: cancelled ? "cancelled" : raw.status as AstraJevDiagnostic["status"],
    reason: cancelled ? "cancelled" : raw.reason as AstraJevReason, evaluationMs: raw.evaluationMs };
}
