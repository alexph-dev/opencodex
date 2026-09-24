/** Synthetic public evidence only; no captured request, tool payload or credential. */
export type FailureHistoryItem = Record<string, unknown>;

export function failedExecution(id: string, kind: "function_call" | "custom_tool_call" = "function_call"): FailureHistoryItem[] {
  return [
    { type: kind, name: "inspect_fixture", call_id: id,
      ...(kind === "function_call" ? { arguments: '{"check":"fixture"}' } : { input: "Inspect fixture" }) },
    { type: `${kind}_output`, call_id: id, status: "failed", output: `Diagnostic ${id}: fixture totals disagree.` },
    { role: "assistant", content: `Corrective explanation ${id}: compare the fixture inputs before retrying.` },
  ];
}

/** All execution groups lie beyond the optional head and before the noisy recent tail. */
export function historyWithMiddleFailures(groups: FailureHistoryItem[][] = [
  failedExecution("older_fixture"), failedExecution("recent_a_fixture"), failedExecution("recent_b_fixture"),
]) {
  const input: FailureHistoryItem[] = [{ role: "user", content: "Original goal: inspect the fixture without changing any records." }];
  let step = 0;
  const noise = (count: number) => {
    for (let i = 0; i < count; i++) input.push({ role: "assistant",
      content: `Optional completed observation ${step++}: ` + "Read-only fixture output was available. ".repeat(20) });
  };
  for (const group of groups) { noise(100); input.push(...group); }
  input.push({ role: "developer", content: "Middle source rule: do not mutate the real system." });
  noise(300);
  input.push({ role: "user", content: "Current goal: investigate the next safe step; keep all original restrictions." });
  return { instructions: "Required source: preserve all user constraints.", input };
}
