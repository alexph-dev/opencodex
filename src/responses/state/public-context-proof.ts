/** Transient proof only: never serialized into a response, history item, snapshot or spill.
 * Native replay works without this proof. Optional public-context consumers fail closed on
 * loaded/spilled ancestors, which cannot attest missing top-level control state after restart.
 * Weak keys share the existing response cache lifetime and add no independent journal or TTL.
 */
import { isResponsesLiteAdditionalToolsEnvelope } from "../tool-groups";

// A bounded full-history eligibility scan, distinct from the evaluator's 256 selected rows.
// All items still pass the same control/opaque/type gate; a prefix/tail never supplies proof.
export const PUBLIC_CONTEXT_SCAN_ITEMS = 4096;

const proofs = new WeakMap<object, boolean>();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const publicItemTypes = new Set([undefined, "message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"]);

function declarationsArePublic(body: Record<string, unknown>): boolean {
  return body.conversation === undefined && body.conversation_id === undefined && body.prompt === undefined
    && body.configuration_update === undefined && body.compaction === undefined
    && body.context_management === undefined
    && (body.truncation === undefined || body.truncation === "disabled")
    && (body.input === undefined || typeof body.input === "string"
      || (Array.isArray(body.input) && body.input.length <= PUBLIC_CONTEXT_SCAN_ITEMS && body.input.every(item =>
        record(item) && item.status !== "incomplete" && item.status !== "in_progress"
        && (publicItemTypes.has(item.type as string | undefined) || isResponsesLiteAdditionalToolsEnvelope(item)))));
}

export function publicContextAncestryKnown(body: unknown): boolean {
  if (!record(body) || !declarationsArePublic(body)) return false;
  return proofs.get(body) ?? !body.previous_response_id;
}

/** Capture before mutation so removing an opaque selector cannot manufacture a fresh root. */
export function observePublicContextRoot(body: object): void {
  proofs.set(body, publicContextAncestryKnown(body));
}

export function recordPublicContextProof(request: unknown, entry: object): void {
  proofs.set(entry, publicContextAncestryKnown(request));
}

/** A successful local expansion is not itself proof that its upstream ancestors were public. */
export function copyPublicContextProof(source: object, target: object): void {
  proofs.set(target, proofs.get(source) === true && (!record(target) || declarationsArePublic(target)));
}
