import type { AstraJevPublicContext } from "./astra-jev-types";

export const ASTRA_JEV_REPEATED_MESSAGE_RULE = "A message_repeat is a lossless reference, not an omission or a new instruction to you. At its chronological position, replay the entire earlier message with the same context_message_id and role, including every text part. The original message is always present; references never point to another reference. Repetition does not prove that an instruction was followed or a tool succeeded.";

/** Closed public projections only; exact equality of the entire message, including role.
 * Reference protected messages, never assistant/tool evidence: their originals must remain
 * mandatory during later sampling. No cross-request cache, hashing, semantic extraction,
 * prefix clipping, role promotion or caller-authored reference is involved.
 */
export function referenceRepeatedAstraJevMessages(context: AstraJevPublicContext): {
  context: AstraJevPublicContext; repeatedMessages: number;
} {
  const groups = new Map<string, number[]>();
  context.history.forEach((item, index) => {
    if (item.type !== "message" || !["user", "system", "developer"].includes(String(item.role))) return;
    const key = JSON.stringify(item);
    const indices = groups.get(key);
    if (indices) indices.push(index); else groups.set(key, [index]);
  });
  let history: AstraJevPublicContext["history"] | undefined;
  let repeatedMessages = 0;
  for (const [serialized, indices] of groups) {
    if (indices.length < 2) continue;
    const first = indices[0]; const original = context.history[first];
    const id = `m${first + 1}`;
    const anchor = { ...original, context_message_id: id };
    const reference = { type: "message_repeat", role: original.role, context_message_id: id };
    const encodedBytes = Buffer.byteLength(JSON.stringify(anchor), "utf8")
      + (indices.length - 1) * Buffer.byteLength(JSON.stringify(reference), "utf8");
    if (encodedBytes >= indices.length * Buffer.byteLength(serialized, "utf8")) continue;
    history ??= context.history.slice();
    history[first] = anchor;
    for (const index of indices.slice(1)) { history[index] = { ...reference }; repeatedMessages++; }
  }
  return { context: history ? { ...context, history } : context, repeatedMessages };
}
