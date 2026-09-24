/** Native Codex's request boundary, shared by parsing and request-local effort selection.
 * Ultra is a client policy label; inference uses max. This does not enable delegation modes.
 */
export function nativeRequestReasoningEffort(effort: string): string;
export function nativeRequestReasoningEffort(effort: string | undefined): string | undefined;
export function nativeRequestReasoningEffort(effort: string | undefined): string | undefined {
  return effort === "ultra" ? "max" : effort;
}
