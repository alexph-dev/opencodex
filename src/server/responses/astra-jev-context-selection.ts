import type { AstraJevContextResult, AstraJevPublicContext, AstraJevMeasurements } from "./astra-jev-types";
import { referenceRepeatedAstraJevMessages } from "./astra-jev-repeated-context";

export const ASTRA_JEV_STATE_BYTES = 96 * 1024;
export const ASTRA_JEV_LEGACY_STATE_BYTES = 64 * 1024;
export const ASTRA_JEV_MAX_ITEMS = 256;
// Local inspection work, not permission to send a larger evaluator request.
export const ASTRA_JEV_SCAN_BYTES = 4 * 1024 * 1024;
const HEAD_SHARE = 0.2;
const SELECTION_NOTE = "History was selected at semantic boundaries. Top-level source instructions stay complete. The latest user, developer and system messages are retained as recency anchors without inferring their scope, together with the latest unit and up to two recent explicitly failed execution groups. Older protected messages may be omitted only whole, with explicit unknown-constraint markers. Remaining capacity favors roughly 20% beginning and 80% recent tail. Omitted actions, instructions, constraints and outcomes are unknown.";
type Unit = {
  start: number; end: number; bytes: number; required: boolean; failed: boolean;
  protectedMessages: number; protectedBytes: number;
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const protectedMessage = (item: Record<string, unknown>) =>
  item.type === "message" && ["user", "system", "developer"].includes(String(item.role));
/** Includes the baseline actually serialized by the client, not just the projected context. */
export const astraJevStateBytes = (context: AstraJevPublicContext, baseline: string) =>
  bytes({ ...context, requested_baseline: baseline });
const fits = (context: AstraJevPublicContext, baseline: string) => context.history.length <= ASTRA_JEV_MAX_ITEMS
  && astraJevStateBytes(context, baseline) <= ASTRA_JEV_STATE_BYTES;

/** Minimal contiguous units: never cut between a known call and its matching result.
 * Interleaved/parallel calls merge their intervals. An unmatched result is not paired
 * by adjacency or guessed successful; its original public projection stays explicit.
 */
function latestProtectedIndices(history: AstraJevPublicContext["history"]): Set<number> {
  const latest = new Map<string, number>();
  history.forEach((item, index) => {
    if (protectedMessage(item)) latest.set(String(item.role), index);
  });
  return new Set(latest.values());
}

function units(history: AstraJevPublicContext["history"], requiredProtected: ReadonlySet<number>): Unit[] {
  const ends = history.map((_, index) => index + 1);
  const calls = new Map<string, number>();
  history.forEach((item, index) => {
    if (typeof item.call_id !== "string") return;
    const type = item.type;
    if (type === "function_call" || type === "custom_tool_call") {
      const key = `${type}:${item.call_id}`;
      if (!calls.has(key)) calls.set(key, index);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const key = `${String(type).replace(/_output$/, "")}:${item.call_id}`;
      const start = calls.get(key);
      if (start !== undefined) { ends[start] = index + 1; calls.delete(key); }
    }
  });
  const result: Unit[] = [];
  for (let start = 0; start < history.length;) {
    let end = ends[start], size = 0, required = false, failed = false;
    let protectedMessages = 0, protectedBytes = 0;
    for (let index = start; index < end; index++) {
      end = Math.max(end, ends[index]);
      const item = history[index];
      const itemBytes = bytes(item) + 1;
      size += itemBytes;
      if (protectedMessage(item)) {
        protectedMessages++;
        protectedBytes += itemBytes;
        required ||= requiredProtected.has(index);
      }
      failed ||= (item.type === "function_call_output" || item.type === "custom_tool_call_output")
        && item.status === "failed";
    }
    result.push({ start, end, bytes: size, required, failed, protectedMessages, protectedBytes }); start = end;
  }
  // The next decision must not lose the most recent available result/analysis.
  if (result.length) result[result.length - 1].required = true;
  return result;
}

/** Selection is evaluator-only. All input was classified before this function runs.
 * Keep short projections byte-equivalent; never summarize or slice required text.
 */
export function selectAstraJevHistory(context: AstraJevPublicContext, baseline = "unset", measured?: AstraJevMeasurements): AstraJevContextResult {
  if (measured) {
    measured.protectedBytes = bytes({ source_instructions: context.source_instructions,
      history: context.history.filter(item => item.type === "message" && item.role !== "assistant"),
      requested_baseline: baseline });
    measured.stateBytes = astraJevStateBytes(context, baseline);
    measured.repeatedMessages = 0;
    measured.omittedProtectedMessages = 0;
    measured.omittedProtectedBytes = 0;
  }
  if (fits(context, baseline)) {
    if (measured) { measured.selectionMode = measured.withheldMediaItems ? "withheld" : "full"; measured.omittedItems = 0; }
    return { context };
  }
  // Try a lossless representation before omitting any history. Repeated constraints
  // remain at every original position, with their full same-role anchor mandatory.
  const originalContext = context;
  const referenced = referenceRepeatedAstraJevMessages(context);
  context = referenced.context;
  if (measured) {
    measured.repeatedMessages = referenced.repeatedMessages;
    measured.stateBytes = astraJevStateBytes(context, baseline);
  }
  if (fits(context, baseline)) {
    if (measured) { measured.selectionMode = measured.withheldMediaItems ? "withheld" : "referenced"; measured.omittedItems = 0; }
    return { context, referenced: true };
  }
  // If references still do not fit, sample original whole messages rather than
  // carrying a custom-reference dependency into an already incomplete projection.
  context = originalContext;
  if (measured) {
    measured.repeatedMessages = 0;
    measured.stateBytes = astraJevStateBytes(context, baseline);
  }
  const groups = units(context.history, latestProtectedIndices(context.history));
  const failures: number[] = [];
  // Count merged execution groups, not individual parallel failures. Only an explicit
  // projected result status is evidence; tool text and caller message fields are not.
  for (let index = groups.length - 1; index >= 0 && failures.length < 2; index--) {
    if (!groups[index].failed) continue;
    groups[index].required = true;
    failures.push(index);
  }
  const selected = new Set(groups.flatMap((unit, index) => unit.required ? [index] : []));
  const materialize = (): AstraJevPublicContext => {
    const history: AstraJevPublicContext["history"] = [];
    let omittedStart = -1, omittedEnd = -1;
    let protectedMessages = 0, protectedBytes = 0;
    const flush = () => {
      if (omittedStart < 0) return;
      history.push({ type: "history_omitted", from_item: omittedStart + 1, through_item: omittedEnd,
        omitted_items: omittedEnd - omittedStart,
        ...(protectedMessages ? {
          omitted_protected_messages: protectedMessages,
          omitted_protected_bytes: protectedBytes,
        } : {}),
        text: protectedMessages
          ? "Public history omitted for budget, including whole user/system/developer messages that may contain governing instructions or constraints. Their contents and scope are unknown; do not infer or reconstruct them."
          : "Public history omitted for budget. Its actions and outcomes are unknown; do not infer success." });
      omittedStart = -1;
      protectedMessages = 0; protectedBytes = 0;
    };
    groups.forEach((unit, index) => {
      if (selected.has(index)) {
        flush();
        for (let i = unit.start; i < unit.end; i++) history.push(context.history[i]);
      } else {
        if (omittedStart < 0) omittedStart = unit.start;
        omittedEnd = unit.end;
        protectedMessages += unit.protectedMessages;
        protectedBytes += unit.protectedBytes;
      }
    });
    flush();
    return { ...context, history, omissions: [...context.omissions, SELECTION_NOTE] };
  };
  let result = materialize();
  // Includes every omission marker and all escaped JSON bytes, not just raw text.
  if (!fits(result, baseline)) {
    if (measured) {
      measured.stateBytes = astraJevStateBytes(result, baseline);
      measured.budgetOwner = result.history.length > ASTRA_JEV_MAX_ITEMS ? "required_items" : "required_state";
      measured.omittedProtectedMessages = groups.reduce((sum, unit, index) =>
        sum + (selected.has(index) ? 0 : unit.protectedMessages), 0);
      measured.omittedProtectedBytes = groups.reduce((sum, unit, index) =>
        sum + (selected.has(index) ? 0 : unit.protectedBytes), 0);
    }
    return { reason: "context_budget" };
  }
  const add = (index: number): boolean => {
    selected.add(index);
    const candidate = materialize();
    if (!fits(candidate, baseline)) { selected.delete(index); return false; }
    result = candidate; return true;
  };
  // Give a directly following public assistant explanation priority over optional noise.
  // Retain the whole unit only if it fits after all mandatory anchors; adjacency does
  // not prove that it corrected the failure. Do not search past intervening items.
  for (const index of failures) {
    const next = groups[index + 1];
    const following = next && context.history[next.start];
    if (following?.type === "message" && following.role === "assistant" && !selected.has(index + 1)) add(index + 1);
  }
  const headBytes = Math.floor((ASTRA_JEV_STATE_BYTES - astraJevStateBytes(result, baseline)) * HEAD_SHARE);
  const headItems = Math.floor((ASTRA_JEV_MAX_ITEMS - result.history.length) * HEAD_SHARE);
  let usedBytes = 0, usedItems = 0;
  for (let index = 0; index < groups.length; index++) {
    if (selected.has(index)) continue;
    const unit = groups[index], count = unit.end - unit.start;
    if (usedBytes >= headBytes || usedItems >= headItems) break;
    if (!add(index)) continue;
    usedBytes += unit.bytes; usedItems += count;
  }
  // Unused head capacity goes to the tail. Stop at a whole unit that cannot fit;
  // do not cherry-pick smaller successes past a larger recent failure.
  for (let index = groups.length - 1; index >= 0; index--) {
    if (!selected.has(index) && !add(index)) break;
  }
  if (measured) {
    measured.selectionMode = "sampled";
    measured.omittedItems = groups.reduce((sum, unit, index) => sum + (selected.has(index) ? 0 : unit.end - unit.start), 0);
    measured.omittedProtectedMessages = groups.reduce((sum, unit, index) =>
      sum + (selected.has(index) ? 0 : unit.protectedMessages), 0);
    measured.omittedProtectedBytes = groups.reduce((sum, unit, index) =>
      sum + (selected.has(index) ? 0 : unit.protectedBytes), 0);
    measured.stateBytes = astraJevStateBytes(result, baseline);
  }
  return { context: result, sampled: true };
}
