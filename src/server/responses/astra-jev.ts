import type { OcxConfig, OcxParsedRequest } from "../../types";
import type { RouteResult } from "../../router";
import type { RequestLogContext } from "../request-log";
import { resolveProviderApiKey } from "../../providers/api-key-resolve";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers-destination";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { gatherNativeModelAliases } from "../../codex/catalog/native-model-aliases";
import { nativeReasoningEfforts } from "../../codex/catalog/metadata";
import { prepareEffortNormalization } from "../effort-policy";
import { nativeRequestReasoningEffort } from "../../responses/request-effort";
import { codexEffortRank } from "../../reasoning-effort";
import { astraJevPublicContext } from "./astra-jev-context";
import { evaluateAstraJev } from "./astra-jev-client";
import {
  ASTRA_JEV_SELECTOR, ASTRA_JEV_NATIVE_MODEL, ASTRA_JEV_EFFORTS, astraJevBaseline, newAstraJevMeasurements,
  type AstraJevDiagnostic, type AstraJevEffort, type AstraJevInvocation,
} from "./astra-jev-types";

/** Only native Responses ingress with this exact selected alias may opt in. */
export function captureAstraJevInvocation(body: unknown, selected: boolean, ancestryComplete: boolean): AstraJevInvocation | undefined {
  if (!selected) return undefined;
  const raw = body as { reasoning?: { effort?: unknown } };
  const requestedBaseline = astraJevBaseline(raw.reasoning?.effort);
  const measurements = newAstraJevMeasurements();
  const start = performance.now();
  const context = process.env.OCX_ASTRA_JEV_ENABLED === "1"
    ? astraJevPublicContext(body, ancestryComplete, requestedBaseline, measurements) : { reason: "disabled" as const };
  measurements.preprocessingMs = Math.round(performance.now() - start);
  return {
    selected: true, requestedBaseline, context, measurements,
  };
}

function canonicalAliasRoute(config: OcxConfig, route: RouteResult): boolean {
  if (route.providerName !== "openai" || route.modelId !== ASTRA_JEV_NATIVE_MODEL || route.combo
    || !isCanonicalOpenAiForwardProvider(resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "responses", route.staticPolicy))) return false;
  if (config.disabledModels?.includes(ASTRA_JEV_SELECTOR)) return false;
  return gatherNativeModelAliases(config).some(row => row.alias === ASTRA_JEV_SELECTOR && row.id === ASTRA_JEV_NATIVE_MODEL);
}

/** Runs once before ordinary effort normalization. Internal retries share the invocation object. */
export async function applyAstraJevEffort(args: {
  invocation: AstraJevInvocation;
  parsed: OcxParsedRequest;
  route: RouteResult;
  config: OcxConfig;
  logCtx: RequestLogContext;
  signal: AbortSignal;
}): Promise<boolean> {
  const { invocation, parsed, route, config, logCtx, signal } = args;
  const diagnostic = (status: AstraJevDiagnostic["status"], reason: AstraJevDiagnostic["reason"]): AstraJevDiagnostic => ({
    ...invocation.measurements,
    selectedAlias: ASTRA_JEV_SELECTOR, requestedBaseline: invocation.requestedBaseline,
    evaluatorChoice: null, finalEffort: null, status, reason, evaluationMs: 0,
  });
  if (signal.aborted) { logCtx.astraJev = diagnostic("cancelled", "cancelled"); return false; }
  if (!canonicalAliasRoute(config, route)) { logCtx.astraJev = diagnostic("skipped", "unvalidated_alias"); return true; }
  // The existing effort snapshot must own the native baseline, not the evaluator's choice.
  // A later route change therefore restores caller effort through the existing normalization.
  prepareEffortNormalization(parsed, route);
  invocation.decision ??= (async () => {
    if (process.env.OCX_ASTRA_JEV_ENABLED !== "1") return diagnostic("skipped", "disabled");
    const context = invocation.context;
    delete invocation.context; // no public text retained after the one evaluator call
    if (parsed._compactionRequest) return diagnostic("skipped", "compaction");
    if (!context || "reason" in context) return diagnostic("skipped", context?.reason ?? "incomplete_context");
    if (invocation.requestedBaseline === "unsupported") return diagnostic("skipped", "unsupported_ladder");
    const nativeLadder = nativeReasoningEfforts(ASTRA_JEV_NATIVE_MODEL);
    if (!nativeLadder.length || nativeLadder.some(effort => !(ASTRA_JEV_EFFORTS as readonly string[]).includes(effort))) return diagnostic("skipped", "unsupported_ladder");
    const key = resolveProviderApiKey("$TYPESAFE_API_KEY");
    if (!key?.trim()) return diagnostic("failed", "credential_unavailable");
    const start = performance.now();
    const evaluated = await evaluateAstraJev({ context: context.context, baseline: invocation.requestedBaseline,
      ladder: nativeLadder as AstraJevEffort[], key, signal, measurements: invocation.measurements });
    const outcome = "choice" in evaluated
      ? { ...diagnostic("applied", "selected"), evaluatorChoice: evaluated.choice }
      : diagnostic(evaluated.reason === "cancelled" ? "cancelled" : "failed", evaluated.reason);
    // A newly sampled view cannot justify a lower baseline until judgment-quality
    // acceptance. Compare at the existing Ultra-to-Max inference boundary, not via
    // another ladder. Preserve the actual choice for the content-free diagnostic.
    if ((context.sampled || context.withheldMedia || context.referenced) && "choice" in evaluated) {
      const baseline = invocation.requestedBaseline;
      if (baseline === "unset") {
        outcome.status = "skipped"; outcome.reason = context.withheldMedia ? "withheld_media_baseline_unknown"
          : context.sampled ? "sampled_baseline_unknown" : "referenced_baseline_unknown";
      } else if (codexEffortRank(nativeRequestReasoningEffort(evaluated.choice))
        < codexEffortRank(nativeRequestReasoningEffort(baseline))) {
        outcome.status = "skipped"; outcome.reason = context.withheldMedia ? "withheld_media_downshift_veto"
          : context.sampled ? "sampled_downshift_veto" : "referenced_downshift_veto";
      }
    }
    outcome.evaluationMs = Math.round(performance.now() - start);
    return outcome;
  })();
  const result = await invocation.decision;
  logCtx.astraJev = { ...result };
  if (signal.aborted || result.status === "cancelled") {
    logCtx.astraJev.status = "cancelled"; logCtx.astraJev.reason = "cancelled"; return false;
  }
  if (result.status === "applied" && result.evaluatorChoice) {
    // Recheck opt-in/alias ownership after the await. Configuration is never mutated here.
    if (process.env.OCX_ASTRA_JEV_ENABLED !== "1" || !canonicalAliasRoute(config, route)) {
      logCtx.astraJev.status = "skipped"; logCtx.astraJev.reason = "route_changed"; return true;
    }
    const effort = nativeRequestReasoningEffort(result.evaluatorChoice);
    parsed.options.reasoning = effort;
    const raw = parsed._rawBody as Record<string, unknown>;
    const reasoning = raw.reasoning;
    raw.reasoning = { ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}), effort };
  }
  return true;
}

/** Called after the native pins, caps and ladder clamp, including subsequent route changes. */
export function recordAstraJevFinalEffort(logCtx: RequestLogContext, parsed: OcxParsedRequest, route: RouteResult): void {
  const diagnostic = logCtx.astraJev;
  if (!diagnostic || diagnostic.status === "cancelled") return;
  diagnostic.finalEffort = astraJevBaseline(parsed.options.reasoning);
  if (diagnostic.status === "applied" && (route.providerName !== "openai" || route.modelId !== ASTRA_JEV_NATIVE_MODEL || !isCanonicalOpenAiForwardProvider(route.provider))) {
    diagnostic.status = "skipped"; diagnostic.reason = "route_changed";
  } else if (diagnostic.status === "applied" && diagnostic.finalEffort !== diagnostic.evaluatorChoice) {
    diagnostic.reason = "constrained";
  }
}
