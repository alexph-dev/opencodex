function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Conservative evaluator subset of the native Responses Lite declaration envelope.
 * Declaration children are arbitrary JSON, not conversation items. Never traverse them here.
 * The general transport collector below deliberately retains its broader existing behavior.
 */
export function isResponsesLiteAdditionalToolsEnvelope(value: unknown): value is {
  type: "additional_tools"; role: "developer"; id?: string | null; tools: unknown[];
} {
  if (!isPlainObject(value) || value.type !== "additional_tools" || value.role !== "developer"
    || !Array.isArray(value.tools) || (value.id !== undefined && value.id !== null && typeof value.id !== "string")) return false;
  // Stop at the first extension, without allocating/traversing a declaration-sized key list.
  for (const key in value) {
    if (key !== "type" && key !== "role" && key !== "id" && key !== "tools") return false;
  }
  return true;
}

/** Collect top-level and Responses Lite tool containers without altering their order. */
export function collectResponsesToolGroups(body: unknown): unknown[][] {
  if (!isPlainObject(body)) return [];

  const groups: unknown[][] = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (!Array.isArray(body.input)) return groups;

  for (const item of body.input) {
    if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      groups.push(item.tools);
    }
  }
  return groups;
}
