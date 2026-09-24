import type { AstraJevContextResult, AstraJevPublicContext, AstraJevReason, AstraJevMeasurements, AstraJevBudgetOwner } from "./astra-jev-types";
import { isResponsesLiteAdditionalToolsEnvelope } from "../../responses/tool-groups";
import { PUBLIC_CONTEXT_SCAN_ITEMS } from "../../responses/state/public-context-proof";
import { ASTRA_JEV_MAX_ITEMS, ASTRA_JEV_SCAN_BYTES, selectAstraJevHistory } from "./astra-jev-context-selection";

export { ASTRA_JEV_STATE_BYTES, ASTRA_JEV_MAX_ITEMS } from "./astra-jev-context-selection";
export const ASTRA_JEV_TOOL_BYTES = 4096;
// Independent privacy-inspection permission; do not widen when transmission budgets grow.
export const ASTRA_JEV_STRUCTURED_TOOL_CHARS = 64 * 1024;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const media = new Set(["input_image", "image", "input_audio", "audio", "input_video", "video", "input_file"]);
const MEDIA_OMISSION = "[historical non-text content withheld; meaning unknown]";
// Binary embedded in a nominally textual tool payload is not evaluator context either.
const encodedMedia = /data:(?:(?:image|audio|video)\/[^\s,]*|application\/octet-stream)[;,]|[A-Za-z0-9+/]{512,}={0,2}/;

/** A JSON string is still structured tool data: withhold media/private fields at any depth.
 * Work is bounded independently of the inbound body limit. Uninspectable structured values
 * are omitted whole rather than exposing their first/last bytes under a text label.
 */
function structuredPayloadIsPrivate(value: string): boolean {
  if (!/^\s*[\[{]/.test(value)) return false;
  if (value.length > ASTRA_JEV_STRUCTURED_TOOL_CHARS) return true;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return true; }
  const pending = [{ value: parsed, depth: 0 }]; let count = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++count > 512 || entry.depth > 8) return true;
    if (!entry.value || typeof entry.value !== "object") continue;
    if (object(entry.value) && (media.has(String(entry.value.type)) || entry.value.type === "reasoning" || entry.value.type === "compaction")) return true;
    const entries = Object.entries(entry.value);
    if (entries.length > 512) return true;
    for (const [key, nested] of entries) {
      if (/^(?:image(?:_url)?|input_image|audio|input_audio|video|input_video|file_data|b64_json|base64|data|encrypted_content|reasoning(?:_content)?)$/i.test(key)) return true;
      pending.push({ value: nested, depth: entry.depth + 1 });
    }
  }
  return false;
}

/** A closed projection: never spread caller items, tool definitions or private reasoning. */
export function astraJevPublicContext(body: unknown, ancestryComplete: boolean, baseline = "unset", measured?: AstraJevMeasurements): AstraJevContextResult {
  const budget = (owner: AstraJevBudgetOwner): AstraJevContextResult => {
    if (measured) measured.budgetOwner = owner;
    return { reason: "context_budget" };
  };
  if (!object(body)) return { reason: "unsupported_item" };
  if (body.generate === false) return { reason: "warmup" };
  if (body.configuration_update !== undefined) return { reason: "configuration_update" };
  // A prompt descriptor can supply unseen instructions/constraints; do not fetch or guess them.
  if (body.prompt !== undefined) return { reason: "opaque_ancestry" };
  if (body.compaction !== undefined || body.context_management !== undefined
    || (body.truncation !== undefined && body.truncation !== "disabled")) return { reason: "incomplete_context" };
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  if (!Array.isArray(input)) return { reason: "unsupported_item" };
  if (input.length > PUBLIC_CONTEXT_SCAN_ITEMS) return budget("inspection_items");
  const context: AstraJevPublicContext = { source_instructions: "", history: [], omissions: [] };
  let reason: AstraJevReason | undefined;
  let hasGoal = false;
  let used = 0;
  let inspectedTextBytes = 0;
  let withheldMediaItems = 0;
  const omit = (label: string) => { if (!context.omissions.includes(label)) context.omissions.push(label); };
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 || encodedMedia.test(value)) { reason ??= "unsupported_item"; return ""; }
    return value;
  };
  const text = (value: unknown, tool = false): string => {
    if (typeof value !== "string") { reason ??= "unsupported_item"; return ""; }
    // Inspect the full supplied public text before selecting any span. A bounded
    // local scan may refuse, but may never hide a control/media item in the middle.
    if (value.length > ASTRA_JEV_SCAN_BYTES - inspectedTextBytes
      || (inspectedTextBytes += Buffer.byteLength(value, "utf8")) > ASTRA_JEV_SCAN_BYTES) {
      if (measured) measured.budgetOwner = "inspection_text";
      reason ??= "context_budget"; return "";
    }
    if (tool && structuredPayloadIsPrivate(value)) {
      omit("Structured tool media/private data or an uninspectable structured payload was withheld.");
      return "[structured tool payload omitted]";
    }
    if (encodedMedia.test(value)) {
      if (!tool) reason ??= "non_text_context";
      omit("Encoded binary content withheld; its meaning is unavailable.");
      return "[encoded binary content omitted]";
    }
    if (tool && Buffer.byteLength(JSON.stringify(value), "utf8") > ASTRA_JEV_TOOL_BYTES - 4) {
      // Both ends retain common command/error summaries. Never claim the omitted middle succeeded.
      const kept = 256;
      omit("Tool text was bounded; omitted portions are not evidence of success or failure.");
      return `${value.slice(0, kept)}\n[${value.length - 2 * kept} UTF-16 code units omitted]\n${value.slice(-kept)}`;
    }
    return value;
  };
  const boundedToolContent = (value: unknown): string[] => {
    const parts = content(value, true);
    if (Buffer.byteLength(JSON.stringify(parts), "utf8") <= ASTRA_JEV_TOOL_BYTES) return parts;
    omit("Multi-part tool output was bounded; omitted portions are not evidence of success or failure.");
    // 256 UTF-16 code units at each end also bound escaped JSON/control characters below 4 KiB.
    return [parts[0]?.slice(0, 256) ?? "", `[middle of ${parts.length} tool output parts omitted]`, parts.at(-1)?.slice(-256) ?? ""];
  };
  const content = (value: unknown, tool = false, allowHistoricalMedia = false): string[] => {
    if (typeof value === "string") return [text(value, tool)];
    if (!Array.isArray(value) || value.length > ASTRA_JEV_MAX_ITEMS) { reason ??= "unsupported_item"; return []; }
    return value.flatMap(part => {
      if (!object(part)) { reason ??= "unsupported_item"; return []; }
      if (part.type === "configuration_update") { reason = "configuration_update"; return []; }
      if (media.has(String(part.type))) {
        if (!tool && !allowHistoricalMedia) { reason ??= "non_text_context"; return []; }
        omit("Non-text tool content withheld; no image/audio/file bytes are available.");
        if (!tool) withheldMediaItems++;
        return [tool ? "[non-text content omitted]" : MEDIA_OMISSION];
      }
      if (part.type === "input_text" || part.type === "output_text" || part.type === "summary_text" || part.type === "text") return [text(part.text, tool)];
      if (part.type === "refusal") return [text(part.refusal, tool)];
      reason ??= "unsupported_item";
      return [];
    });
  };
  if (body.instructions !== undefined) context.source_instructions = text(body.instructions);
  used += Buffer.byteLength(context.source_instructions, "utf8");
  let latestUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (object(item) && item.role === "user") { latestUserIndex = index; break; }
  }
  for (const [index, item] of input.entries()) {
    if (!object(item)) return { reason: "unsupported_item" };
    if (item.type === "configuration_update") return { reason: "configuration_update" };
    if (item.type === "compaction" || item.type === "compaction_trigger") return { reason: "compaction" };
    if (item.type === "item_reference") return { reason: "opaque_ancestry" };
    if (item.status === "incomplete" || item.status === "in_progress") return { reason: "incomplete_context" };
    let projected: Record<string, unknown>;
    switch (item.type) {
      case "additional_tools":
        if (!isResponsesLiteAdditionalToolsEnvelope(item)) return { reason: "unsupported_item" };
        // Match omitted top-level declarations without exposing schemas, IDs or private fields.
        // Keep chronology; declaration data neither executes a tool nor supplies a user goal.
        omit("Tool declarations withheld; their capabilities and restrictions are unavailable to the evaluator.");
        projected = { type: "tool_declarations_omitted", text: "Responses Lite tool declarations omitted; no execution implied." };
        break;
      case undefined:
      case "message": {
        if (!["user", "assistant", "system", "developer"].includes(String(item.role))) return { reason: "unsupported_item" };
        const parts = content(item.content, false, item.role === "user" && index !== latestUserIndex);
        if (item.role === "user" && parts.some(value => value.trim() && value !== MEDIA_OMISSION)) hasGoal = true;
        projected = { type: "message", role: item.role, text: parts };
        break;
      }
      case "reasoning":
        // This known item is private reasoning, not an opaque conversation/compaction reference.
        // Only explicitly public summaries may cross; content and encrypted_content never do.
        omit("Private reasoning content and encrypted reasoning blobs withheld.");
        projected = { type: "public_reasoning_summary", text: item.summary === undefined ? [] : content(item.summary) };
        break;
      case "function_call":
      case "custom_tool_call":
        projected = { type: item.type, name: identifier(item.name),
          ...(typeof item.namespace === "string" ? { namespace: identifier(item.namespace) } : {}),
          ...(typeof item.call_id === "string" ? { call_id: identifier(item.call_id) } : {}),
          arguments: text(item.type === "function_call" ? item.arguments : item.input, true) };
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        projected = { type: item.type,
          ...(typeof item.call_id === "string" ? { call_id: identifier(item.call_id) } : {}),
          output: boundedToolContent(item.output),
          ...(item.status === "failed" ? { status: "failed" } : {}) };
        break;
      default:
        // Unknown public/control types stay on native forwarding; do not serialize them to Jev.
        return { reason: "unsupported_item" };
    }
    if (reason) return { reason };
    used += Buffer.byteLength(JSON.stringify(projected), "utf8");
    if (used > ASTRA_JEV_SCAN_BYTES) return budget("inspection_projection");
    context.history.push(projected);
  }
  if (reason) return { reason };
  if (!ancestryComplete || body.conversation !== undefined || body.conversation_id !== undefined) return { reason: "opaque_ancestry" };
  if (!hasGoal) return { reason: "no_public_goal" };
  if (measured) measured.withheldMediaItems = withheldMediaItems;
  const selected = selectAstraJevHistory(context, baseline, measured);
  if ("context" in selected && withheldMediaItems > 0) selected.withheldMedia = true;
  return selected;
}
