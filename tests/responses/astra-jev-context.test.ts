import { expect, test } from "bun:test";
import { astraJevPublicContext, ASTRA_JEV_STATE_BYTES, ASTRA_JEV_TOOL_BYTES, ASTRA_JEV_STRUCTURED_TOOL_CHARS } from "../../src/server/responses/astra-jev-context";
import { publicContextAncestryKnown, PUBLIC_CONTEXT_SCAN_ITEMS } from "../../src/responses/state/public-context-proof";
import { ASTRA_JEV_SCAN_BYTES } from "../../src/server/responses/astra-jev-context-selection";
import { collectResponsesToolGroups, isResponsesLiteAdditionalToolsEnvelope } from "../../src/responses/tool-groups";
import { astraJevSizedProfile, PROFILE_CONTENT_BYTES } from "../helpers/astra-jev-sized-profile";
import { newAstraJevMeasurements } from "../../src/server/responses/astra-jev-types";
import { astraJevStateBytes } from "../../src/server/responses/astra-jev-context-selection";
import { failedExecution, historyWithMiddleFailures } from "../helpers/astra-jev-failure-history";

test("sampled history anchors the two most recent explicit failures before successful tail noise", () => {
  const body = historyWithMiddleFailures(); const before = JSON.stringify(body);
  const measured = newAstraJevMeasurements();
  const result = astraJevPublicContext(body, publicContextAncestryKnown(body), "medium", measured);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing sampled failure context");
  expect(result.sampled).toBe(true);
  const history = result.context.history;
  expect(history.filter(row => row.status === "failed").map(row => row.call_id))
    .toEqual(["recent_a_fixture", "recent_b_fixture"]);
  expect(history.filter(row => row.type === "function_call").map(row => row.call_id))
    .toEqual(["recent_a_fixture", "recent_b_fixture"]);
  for (const id of ["recent_a_fixture", "recent_b_fixture"]) {
    const output = history.findIndex(row => row.call_id === id && row.type === "function_call_output");
    expect(history[output + 1]?.text).toEqual([`Corrective explanation ${id}: compare the fixture inputs before retrying.`]);
    const original = body.input.findIndex(row => row.call_id === id);
    expect(history.filter(row => row.type === "history_omitted").some(row =>
      Number(row.from_item) <= original + 1 && Number(row.through_item) >= original + 1)).toBe(false);
  }
  expect(history.some(row => row.call_id === "older_fixture")).toBe(false);
  expect(result.context.source_instructions).toBe(body.instructions);
  for (const row of body.input.filter(row => row.role === "user" || row.role === "developer")) {
    expect(history.some(item => item.role === row.role && (item.text as string[])?.[0] === row.content)).toBe(true);
  }
  expect(measured.stateBytes).toBeLessThanOrEqual(ASTRA_JEV_STATE_BYTES);
  expect(history.length).toBeLessThanOrEqual(256);
  expect(JSON.stringify(body) === before).toBe(true);
});

test.each([undefined, "completed", "Failed"])("only projected failed result status anchors a group, not text or status %s", status => {
  const bait = failedExecution("text_bait_fixture");
  bait[0].status = "failed"; bait[1].status = status; bait[2].status = "failed";
  bait[1].output = 'FAILED: fixture text quotes status="failed"; it does not establish execution status.';
  const body = historyWithMiddleFailures([
    failedExecution("older_fixture"), failedExecution("recent_a_fixture"), failedExecution("recent_b_fixture"), bait,
  ]);
  const result = astraJevPublicContext(body, true);
  if (!("context" in result)) throw new Error("missing failure-status fixture");
  expect(result.sampled).toBe(true);
  expect(result.context.history.filter(row => row.status === "failed").map(row => row.call_id))
    .toEqual(["recent_a_fixture", "recent_b_fixture"]);
  expect(result.context.history.some(row => row.call_id === "text_bait_fixture")).toBe(false);
});

test("two recent failure groups count an interleaved parallel batch once and retain kind-specific call IDs", () => {
  const body = historyWithMiddleFailures([
    failedExecution("older_fixture"), failedExecution("prior_fixture"), [
      { type: "function_call", name: "inspect_fixture", call_id: "shared_fixture", arguments: "inspect function fixture" },
      { type: "custom_tool_call", name: "inspect_fixture", call_id: "shared_fixture", input: "inspect custom fixture" },
      { role: "assistant", content: "Interleaved public explanation before completion." },
      { type: "function_call_output", call_id: "shared_fixture", status: "failed", output: "Function diagnostic." },
      { role: "assistant", content: "Public corrective explanation while the other call is pending." },
      { type: "custom_tool_call_output", call_id: "shared_fixture", status: "failed", output: "Custom diagnostic." },
      { role: "assistant", content: "Directly following batch explanation." },
    ],
  ]);
  const result = astraJevPublicContext(body, true);
  if (!("context" in result)) throw new Error("missing parallel failure fixture");
  const execution = result.context.history.filter(row => typeof row.call_id === "string");
  expect(execution.map(row => `${row.type}:${row.call_id}`)).toEqual([
    "function_call:prior_fixture", "function_call_output:prior_fixture",
    "function_call:shared_fixture", "custom_tool_call:shared_fixture",
    "function_call_output:shared_fixture", "custom_tool_call_output:shared_fixture",
  ]);
  expect(execution.filter(row => row.status === "failed")).toHaveLength(3);
  for (const text of ["Interleaved public explanation before completion.",
    "Public corrective explanation while the other call is pending.", "Directly following batch explanation."]) {
    expect(result.context.history.some(row => (row.text as string[])?.[0] === text)).toBe(true);
  }
});

test("unmatched failed outputs are retained without inventing missing or wrong-kind calls", () => {
  const body = historyWithMiddleFailures([failedExecution("older_fixture"), [
    { type: "function_call", name: "inspect_fixture", call_id: "wrong_kind_fixture", arguments: "inspect fixture" },
    { type: "custom_tool_call_output", call_id: "wrong_kind_fixture", status: "failed", output: "Unmatched custom diagnostic." },
    { role: "assistant", content: "The custom caller is not in the provided history." },
  ], [
    { type: "function_call_output", status: "failed", output: "No public call ID available." },
    { role: "assistant", content: "Do not guess the absent call." },
  ]]);
  const result = astraJevPublicContext(body, true);
  if (!("context" in result)) throw new Error("missing unmatched failure fixture");
  expect(result.context.history.filter(row => row.type === "function_call" || row.type === "custom_tool_call")).toHaveLength(0);
  const failed = result.context.history.filter(row => row.status === "failed");
  expect(failed).toHaveLength(2); expect(failed[0].call_id).toBe("wrong_kind_fixture");
  expect(failed[1]).not.toHaveProperty("call_id");
});

test.each(["bytes", "items"])("failure anchors exceeding required %s budget refuse rather than dropping evidence", dimension => {
  const large = failedExecution("large_fixture");
  large.splice(1, 0, ...Array.from({ length: dimension === "items" ? 257 : 2 }, () => ({
    role: "assistant", content: dimension === "items" ? "Public interleaved observation." : "Large public observation. ".repeat(2200),
  })));
  const body = historyWithMiddleFailures([large, failedExecution("recent_fixture")]);
  const before = JSON.stringify(body); const measured = newAstraJevMeasurements();
  expect(astraJevPublicContext(body, true, "high", measured)).toEqual({ reason: "context_budget" });
  expect(measured.budgetOwner).toBe(dimension === "items" ? "required_items" : "required_state");
  expect(measured.selectionMode).toBe("unavailable");
  expect(JSON.stringify(body) === before).toBe(true);
  // With no explicit failure the large old group is optional; no hidden cap increase is needed.
  large.find(row => row.type === "function_call_output")!.status = "completed";
  expect("context" in astraJevPublicContext(body, true)).toBe(true);
});

test("an oversized following explanation is omitted whole without displacing failure or source anchors", () => {
  const recent = failedExecution("recent_b_fixture");
  recent[2].content = "Oversized explanation still public. ".repeat(4000);
  const body = historyWithMiddleFailures([failedExecution("older_fixture"), failedExecution("recent_a_fixture"), recent]);
  const measured = newAstraJevMeasurements();
  const result = astraJevPublicContext(body, true, "high", measured);
  if (!("context" in result)) throw new Error("oversized optional explanation should not block anchors");
  expect(result.context.history.filter(row => row.status === "failed").map(row => row.call_id))
    .toEqual(["recent_a_fixture", "recent_b_fixture"]);
  expect(result.context.history.some(row => (row.text as string[])?.[0]?.startsWith("Oversized explanation"))).toBe(false);
  expect(result.context.history.some(row => (row.text as string[])?.[0]?.startsWith("Corrective explanation recent_a_fixture"))).toBe(true);
  expect(measured.stateBytes).toBeLessThanOrEqual(ASTRA_JEV_STATE_BYTES);
  expect(measured.budgetOwner).toBeNull();
});

test("failure companions do not search past an intervening user message", () => {
  const separated = failedExecution("separated_fixture");
  separated.splice(2, 0, { role: "user", content: "Binding correction between failure and explanation." });
  const body = historyWithMiddleFailures([failedExecution("prior_fixture"), separated]);
  // Remove the helper's later user goal so the intervening correction is the latest
  // user recency anchor and cannot itself be sampled away.
  body.input.pop();
  const result = astraJevPublicContext(body, true);
  if (!("context" in result)) throw new Error("missing separated fixture");
  expect(result.context.history.some(row => row.call_id === "separated_fixture" && row.status === "failed")).toBe(true);
  expect(result.context.history.some(row => (row.text as string[])?.[0] === "Binding correction between failure and explanation.")).toBe(true);
  expect(result.context.history.some(row => (row.text as string[])?.[0]?.startsWith("Corrective explanation separated_fixture"))).toBe(false);
});

test("anchored failure intervals retain privacy omissions without exposing declarations or private reasoning", () => {
  const recent = failedExecution("recent_fixture");
  recent[1].output = JSON.stringify({ encrypted_content: "hidden_tool_sentinel" });
  recent.splice(1, 0,
    { type: "reasoning", content: "hidden_reasoning_sentinel", encrypted_content: "hidden_cipher_sentinel",
      summary: [{ type: "summary_text", text: "Public in-batch summary." }] },
    { type: "additional_tools", role: "developer", tools: [{ description: "hidden_declaration_sentinel" }] });
  const body = historyWithMiddleFailures([failedExecution("prior_fixture"), recent]);
  const result = astraJevPublicContext(body, true);
  if (!("context" in result)) throw new Error("missing private failure fixture");
  expect(result.context.history.filter(row => row.status === "failed").map(row => row.call_id))
    .toEqual(["prior_fixture", "recent_fixture"]);
  expect(JSON.stringify(result).includes("hidden_")).toBe(false);
  expect(JSON.stringify(result).includes("structured tool payload omitted")).toBe(true);
  expect(result.context.history.some(row => row.type === "tool_declarations_omitted")).toBe(true);
});

test.each([
  [{ type: "configuration_update", value: "hidden_control_sentinel" }, "configuration_update"],
  [{ type: "item_reference", id: "hidden_reference_sentinel" }, "opaque_ancestry"],
  [{ type: "future_control", value: "hidden_unknown_sentinel" }, "unsupported_item"],
] as const)("failure anchoring never bypasses classification of %j inside its interval", (item, reason) => {
  const recent = failedExecution("recent_fixture"); recent.splice(1, 0, item);
  expect(astraJevPublicContext(historyWithMiddleFailures([recent]), true)).toEqual({ reason });
});

test("full permitted history retains all failed groups without introducing sampling", () => {
  const body = { input: [{ role: "user", content: "Read the complete fixture." },
    ...failedExecution("first_fixture"), ...failedExecution("second_fixture"), ...failedExecution("third_fixture")] };
  const result = astraJevPublicContext(body, true);
  if (!("context" in result)) throw new Error("small complete fixture should fit");
  expect(result.sampled).toBeUndefined(); expect(result.context.history.length).toBe(body.input.length);
  expect(result.context.history.filter(row => row.status === "failed")).toHaveLength(3);
  expect(result.context.history.some(row => row.type === "history_omitted")).toBe(false);
});

test("96 KiB selection admission includes the exact baseline and escaped Unicode", () => {
  const baseline = "high"; const text = 'Keep 日本語 and 😀, quote " and slash \\.\n';
  const body = { instructions: text, input: [{ role: "user", content: "Keep every constraint." }] };
  const first = astraJevPublicContext(body, true, baseline);
  if (!("context" in first)) throw new Error("small fixture failed");
  const remaining = ASTRA_JEV_STATE_BYTES - astraJevStateBytes(first.context, baseline);
  body.instructions += "f ".repeat(Math.ceil(remaining / 2)).slice(0, remaining);
  const measured = newAstraJevMeasurements();
  const result = astraJevPublicContext(body, true, baseline, measured);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("exact state boundary failed");
  expect(result.context.source_instructions === body.instructions).toBe(true);
  expect(measured.stateBytes).toBe(98304); expect(measured.omittedItems).toBe(0);
  expect(result.sampled).toBeUndefined();
  body.instructions += "x";
  const rejected = newAstraJevMeasurements();
  expect(astraJevPublicContext(body, true, baseline, rejected)).toEqual({ reason: "context_budget" });
  expect(rejected.budgetOwner).toBe("required_state"); expect(rejected.stateBytes).toBeGreaterThan(98304);
});

test("structured-tool inspection stays exactly 65536 UTF-16 units, independent of outbound cap", () => {
  expect(ASTRA_JEV_STRUCTURED_TOOL_CHARS).toBe(65536); expect(ASTRA_JEV_STATE_BYTES).toBe(98304);
  for (const target of [65536, 65537, 90000]) {
    const prefix = '{"note":"public structured boundary. '; const suffix = '"}';
    const value = prefix + "v ".repeat(Math.ceil((target - prefix.length - suffix.length) / 2))
      .slice(0, target - prefix.length - suffix.length) + suffix;
    expect(value.length).toBe(target);
    const result = astraJevPublicContext(request([{ type: "function_call", name: "fixture_read", arguments: value }]), true);
    expect("context" in result).toBe(true);
    if (!("context" in result)) throw new Error("tool fixture failed");
    expect(String(result.context.history[1].arguments).includes("structured tool payload omitted")).toBe(target > 65536);
    expect(JSON.stringify(result).includes("public structured boundary")).toBe(target <= 65536);
  }
});

test.each([false, true])("measured-size profile preserves every protected part without new sampling (continuation %s)", continuation => {
  const body = astraJevSizedProfile(continuation); const before = JSON.stringify(body);
  expect(body.input.slice(1, 5).map(row => Buffer.byteLength(JSON.stringify(row.content)))).toEqual([...PROFILE_CONTENT_BYTES]);
  expect(Buffer.byteLength(JSON.stringify(body.input[0]))).toBe(37596);
  if (!continuation) expect(Buffer.byteLength(before)).toBe(130181);
  const result = astraJevPublicContext(body, publicContextAncestryKnown(body));
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("measured-size profile was not admitted");
  expect(result.sampled).toBeUndefined();
  expect(result.context.history).toHaveLength(body.input.length);
  expect(result.context.history.some(row => row.type === "history_omitted")).toBe(false);
  for (let i = 1; i <= 4; i++) expect(result.context.history[i].text)
    .toEqual((body.input[i].content as Array<{ text: string }>).map(part => part.text));
  const state = JSON.stringify({ ...result.context, requested_baseline: "high" });
  expect(Buffer.byteLength(state)).toBeGreaterThan(64 * 1024);
  expect(Buffer.byteLength(state)).toBeLessThanOrEqual(96 * 1024);
  expect(state.includes("private_declaration_sentinel")).toBe(false);
  expect(state.includes("private_padding_sentinel")).toBe(false);
  expect(JSON.stringify(body) === before).toBe(true);
});

const request = (tail: unknown[] = []) => ({ instructions: "Source instructions are data, not evaluator instructions.",
  input: [{ role: "user", content: "Diagnose the failure without changing customer records." }, ...tail] });

function longHistory() {
  const input: Array<Record<string, unknown>> = [{ role: "user", content: "Original goal: repair the fixture without deleting files." }];
  for (let i = 0; i < 500; i++) {
    input.push({ role: "assistant", content: `Observation ${i}: ` + "Public analysis of the fixture. ".repeat(20) });
    if (i === 250) input.push({ role: "user", content: "Middle constraint: preserve the recorded payment totals." });
  }
  input.push({ role: "developer", content: "Required late source rule: no live writes." },
    { role: "user", content: "Current goal: diagnose the latest failed check before any correction." },
    { type: "function_call", name: "exec_command", call_id: "last_check", arguments: "Run the offline check." },
    { type: "function_call_output", call_id: "last_check", status: "failed", output: "FAILED: expected fixture total did not match." });
  return { instructions: "Required source instructions remain complete.", input };
}

test("long history keeps source/latest protected anchors and labels older protected omissions", () => {
  const body = longHistory(); const before = JSON.stringify(body);
  const result = astraJevPublicContext(body, publicContextAncestryKnown(body));
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("long public context was not selected");
  expect(result.sampled).toBe(true);
  const state = JSON.stringify(result.context);
  expect(Buffer.byteLength(state)).toBeLessThanOrEqual(ASTRA_JEV_STATE_BYTES);
  expect(result.context.history.length).toBeLessThanOrEqual(256);
  expect(result.context.source_instructions).toBe(body.instructions);
  expect(state).toContain("Original goal: repair the fixture without deleting files.");
  expect(state).toContain("Required late source rule: no live writes.");
  expect(state).toContain("Current goal: diagnose the latest failed check before any correction.");
  expect(state).toContain("Observation 0:"); expect(state).toContain("Observation 499:");
  expect(state).not.toContain("Observation 200:");
  expect(state).toContain("FAILED: expected fixture total did not match.");
  const protectedMarkers = result.context.history.filter(item => item.type === "history_omitted"
    && typeof item.omitted_protected_messages === "number");
  expect(protectedMarkers.length).toBeGreaterThan(0);
  expect(protectedMarkers.some(item => Number(item.omitted_protected_messages) > 0)).toBe(true);
  expect(result.context.omissions.join(" ")).toContain("unknown");
  expect(JSON.stringify(body)).toBe(before);
});

test("sampling provenance is internal and does not relabel full privacy-safe projections", () => {
  const body = { ...request([{ type: "function_call_output", call_id: "fixture",
    output: "Public tool text. ".repeat(1000) }]), sampled: true,
    omissions: ["history_omitted"], selection: { sampled: true } };
  const result = astraJevPublicContext(body, true);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing full projection");
  expect(result.sampled).toBeUndefined();
  expect(result.context).not.toHaveProperty("sampled");
  expect(result.context.omissions.join(" ")).toContain("Tool text was bounded");
});

test.each([
  [{ type: "configuration_update", value: "private" }, "configuration_update"],
  [{ type: "compaction", encrypted_content: "private" }, "compaction"],
  [{ type: "item_reference", id: "opaque" }, "opaque_ancestry"],
  [{ type: "future_item", secret: "private" }, "unsupported_item"],
  [{ role: "assistant", status: "incomplete", content: "partial" }, "incomplete_context"],
] as const)("long history inspects excluded middle item %j before selection", (item, reason) => {
  const body = longHistory(); body.input.splice(200, 0, item as Record<string, unknown>);
  expect(astraJevPublicContext(body, true)).toEqual({ reason });
});

test("historical user media is withheld as unknown while current-turn media stays ineligible", () => {
  const historical = longHistory();
  historical.input.splice(200, 0, { role: "user", content: [
    { type: "input_text", text: "Historical public note." },
    { type: "input_image", image_url: "private_historical_image" },
  ] });
  const measured = newAstraJevMeasurements();
  const result = astraJevPublicContext(historical, true, "medium", measured);
  expect("context" in result).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private_historical_image");
  expect(result).toMatchObject({ withheldMedia: true });
  expect(measured).toMatchObject({ selectionMode: "sampled", withheldMediaItems: 1 });
  expect(astraJevPublicContext({ input: [
    { role: "user", content: "Earlier text." },
    { role: "user", content: [{ type: "input_image", image_url: "private_current_image" }] },
  ] }, true)).toEqual({ reason: "non_text_context" });
});

test("large current goal still fails closed while older distinct user constraints can be sampled whole", () => {
  const body = longHistory(); body.input.push({ role: "user", content: "Required. ".repeat(10000) });
  expect(astraJevPublicContext(body, true)).toEqual({ reason: "context_budget" });
  const measured = newAstraJevMeasurements();
  const sampled = astraJevPublicContext({ input: Array.from({ length: 300 }, (_, i) => ({
    role: "user", content: `Constraint ${i}: ${"x".repeat(500)}`,
  })) }, true, "medium", measured);
  expect("context" in sampled).toBe(true);
  if (!("context" in sampled)) throw new Error("distinct protected history should sample");
  expect(sampled.sampled).toBe(true);
  expect(JSON.stringify(sampled.context)).toContain("Constraint 299:");
  expect(measured.omittedProtectedMessages).toBeGreaterThan(0);
  expect(measured.omittedProtectedBytes).toBeGreaterThan(0);
  expect(measured.stateBytes).toBeLessThanOrEqual(ASTRA_JEV_STATE_BYTES);
});

test("item-count selection keeps a larger recent tail and explicit chronological span counts", () => {
  const body = { input: [{ role: "user", content: "Keep this original goal." },
    ...Array.from({ length: 1000 }, (_, i) => ({ role: "assistant", content: `Step ${i}` })),
    { role: "user", content: "Current goal remains complete." }] };
  const result = astraJevPublicContext(body, true);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing selected history");
  expect(result.context.history.length).toBeLessThanOrEqual(256);
  const steps = result.context.history.filter(row => row.role === "assistant").map(row => Number((row.text as string[])[0].slice(5)));
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
  expect(steps[0]).toBe(0); expect(steps.at(-1)).toBe(999);
  expect(steps.filter(i => i >= 500).length).toBeGreaterThan(steps.filter(i => i < 500).length * 3);
  const spans = result.context.history.filter(row => row.type === "history_omitted");
  expect(spans.length).toBe(1);
  expect(Number(spans[0].omitted_items) + steps.length).toBe(1000);
  expect(Number(spans[0].through_item) - Number(spans[0].from_item) + 1).toBe(Number(spans[0].omitted_items));
});

test("matched interleaved calls and results remain whole selection units", () => {
  const input: Array<Record<string, unknown>> = [{ role: "user", content: "Inspect the fixture only." }];
  for (let i = 0; i < 220; i++) input.push(
    { type: "function_call", name: "exec_command", call_id: `call_a_${i}`, arguments: "read fixture" },
    { type: "function_call", name: "exec_command", call_id: `call_b_${i}`, arguments: "check fixture" },
    { role: "assistant", content: "Public interleaved commentary." },
    { type: "function_call_output", call_id: `call_a_${i}`, output: "fixture output" },
    { type: "function_call_output", call_id: `call_b_${i}`, status: "failed", output: "FAILED fixture check" });
  const result = astraJevPublicContext({ input }, true);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing selected tool history");
  const calls = result.context.history.filter(row => row.type === "function_call").map(row => row.call_id);
  const outputs = result.context.history.filter(row => row.type === "function_call_output").map(row => row.call_id);
  expect(calls).toEqual(outputs);
  expect(calls).toContain("call_a_0"); expect(calls).toContain("call_b_219");
  expect(result.context.history.at(-1)?.status).toBe("failed");
});

test("escaped Unicode required text is whole and the final serialized budget is exact", () => {
  const body = longHistory();
  body.instructions = "Required source: \"retain\" \\ paths 😀.\n".repeat(40);
  body.input.splice(250, 0, { role: "system", content: "Retain Unicode constraint 日本語 😀.\n".repeat(100) });
  const result = astraJevPublicContext(body, true);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing unicode context");
  expect(result.context.source_instructions).toBe(body.instructions);
  expect(result.context.history.find(row => row.role === "system")?.text).toEqual([body.input[250].content]);
  expect(Buffer.byteLength(JSON.stringify(result.context))).toBeLessThanOrEqual(ASTRA_JEV_STATE_BYTES);
});

test("long selection retains sanitization and never turns hidden media into evaluator text", () => {
  const body = longHistory();
  body.input.splice(200, 0, { type: "reasoning", content: "private_reasoning_fixture", encrypted_content: "private_cipher_fixture",
    summary: [{ type: "summary_text", text: "Public checkpoint summary." }] });
  body.input.push({ type: "function_call_output", call_id: "private_fixture",
    output: JSON.stringify({ encrypted_content: "private_tool_fixture", data: "private_data_fixture" }) });
  const result = astraJevPublicContext(body, true);
  expect("context" in result).toBe(true);
  const state = JSON.stringify(result);
  expect(state).not.toMatch(/private_reasoning_fixture|private_cipher_fixture|private_tool_fixture|private_data_fixture/);
  expect(state).toContain("structured tool payload omitted");
});

test("local inspection and required latest-unit bounds refuse without growing evaluator budgets", () => {
  const tooMany = { input: Array(PUBLIC_CONTEXT_SCAN_ITEMS + 1).fill({ role: "assistant", content: "Small public item." }) };
  expect(publicContextAncestryKnown(tooMany)).toBe(false);
  expect(astraJevPublicContext(tooMany, true)).toEqual({ reason: "context_budget" });
  expect(astraJevPublicContext(request([{ role: "assistant", content: "Public. ".repeat(ASTRA_JEV_SCAN_BYTES / 8 + 1) }]), true))
    .toEqual({ reason: "context_budget" });
  expect(astraJevPublicContext(request([{ role: "assistant", content: "Latest required analysis. ".repeat(5000) }]), true))
    .toEqual({ reason: "context_budget" });
});

test("each multi-part tool result has one bounded, explicitly labelled budget", () => {
  const result = astraJevPublicContext(request([{ type: "function_call_output", call_id: "fixture",
    output: Array.from({ length: 12 }, () => ({ type: "output_text", text: "public output line. ".repeat(100) })),
  }]), true);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing context");
  expect(Buffer.byteLength(JSON.stringify(result.context.history[1].output), "utf8")).toBeLessThanOrEqual(ASTRA_JEV_TOOL_BYTES);
  expect(result.context.omissions.join(" ")).toContain("bounded");
});

test("structured tool argument media payloads never become evaluator text", () => {
  const result = astraJevPublicContext(request([{ type: "function_call", name: "inspect_image", call_id: "fixture",
    arguments: JSON.stringify({ image: { data: "small_binary_sentinel" } }),
  }]), true);
  expect(JSON.stringify(result)).not.toContain("small_binary_sentinel");
});

test("required user constraints exceeding the total budget are refused, never truncated", () => {
  const body = request(); body.input.push({ role: "user", content: "Important constraint. ".repeat(ASTRA_JEV_STATE_BYTES) });
  expect(astraJevPublicContext(body, true)).toEqual({ reason: "context_budget" });
  expect(astraJevPublicContext({ ...request(), instructions: "Required instructions. ".repeat(ASTRA_JEV_STATE_BYTES) }, true))
    .toEqual({ reason: "context_budget" });
});

test("tool media is labelled; user media, control changes and incomplete ancestry skip evaluation", () => {
  const tool = astraJevPublicContext(request([{ type: "function_call_output", call_id: "fixture", output: [
    { type: "input_image", image_url: "data:image/png;base64,private_image_sentinel" },
    { type: "output_text", text: "Command failed: image not recognized." },
  ] }]), true);
  expect("context" in tool).toBe(true); expect(JSON.stringify(tool)).not.toContain("private_image_sentinel");
  expect(JSON.stringify(tool)).toContain("Command failed");
  expect(astraJevPublicContext({ input: [{ role: "user", content: [{ type: "input_image", image_url: "private" }] }] }, true))
    .toEqual({ reason: "non_text_context" });
  expect(astraJevPublicContext(request(), false)).toEqual({ reason: "opaque_ancestry" });
  expect(astraJevPublicContext(request([{ type: "configuration_update", value: "private" }]), true))
    .toEqual({ reason: "configuration_update" });
  expect(astraJevPublicContext(request([{ type: "message", role: "assistant", content: "partial", status: "incomplete" }]), true))
    .toEqual({ reason: "incomplete_context" });
});

test("unknown types and private reasoning internals are not serialized", () => {
  expect(astraJevPublicContext(request([{ type: "future_item", secret: "unknown_sentinel" }]), true))
    .toEqual({ reason: "unsupported_item" });
  const body = request([{ type: "reasoning", content: "private_reasoning_sentinel", encrypted_content: "ciphertext_sentinel",
    summary: [{ type: "summary_text", text: "Public summary" }] }]);
  const before = JSON.stringify(body); const result = astraJevPublicContext(body, true);
  expect(JSON.stringify(result)).toContain("Public summary");
  expect(JSON.stringify(result)).not.toMatch(/private_reasoning_sentinel|ciphertext_sentinel/);
  expect(JSON.stringify(body)).toBe(before);
});

test("no public user goal cannot be invented from tool outputs", () => {
  expect(astraJevPublicContext({ input: [{ type: "function_call_output", call_id: "fixture", output: "failed" }] }, true))
    .toEqual({ reason: "no_public_goal" });
});

test.each([null, {}, "prompt_fixture", { id: "prompt_fixture", variables: { constraint: "unseen" } }])("opaque prompt %j fails both context gates without reconstruction", prompt => {
  const body = { ...request(), prompt };
  const before = JSON.stringify(body);
  expect(astraJevPublicContext(body, true)).toEqual({ reason: "opaque_ancestry" });
  expect(publicContextAncestryKnown(body)).toBe(false);
  expect(JSON.stringify(body)).toBe(before);
  expect(publicContextAncestryKnown(request())).toBe(true);
});

const liteDeclaration = () => ({ type: "additional_tools", role: "developer", id: "at_private_fixture", tools: [
  { type: "namespace", name: "private_namespace_fixture", tools: [{ type: "function", name: "private_name_fixture",
    description: "private_description_fixture", parameters: { properties: { secret: { default: "private_default_fixture" } } } }] },
] });

test("Responses Lite declarations establish public ancestry independently of the projector", () => {
  expect(publicContextAncestryKnown({ input: [liteDeclaration(), ...request().input] })).toBe(true);
});

test("Responses Lite declarations project a fixed chronological omission independently of ancestry", () => {
  const declaration = liteDeclaration();
  const body = { input: [declaration, { type: "message", role: "developer", content: "Keep all user constraints." },
    ...request().input, { ...declaration, id: null }] };
  const before = JSON.stringify(body);
  const result = astraJevPublicContext(body, true);
  expect("context" in result).toBe(true);
  if (!("context" in result)) throw new Error("missing context");
  expect(result.context.history.map(item => item.type)).toEqual(["tool_declarations_omitted", "message", "message", "tool_declarations_omitted"]);
  expect(result.context.history[0]).toEqual(result.context.history[3]);
  expect(result.context.omissions.join(" ")).toContain("Tool declarations withheld");
  expect(JSON.stringify(result)).not.toMatch(/private_.*fixture/);
  expect(result.context.history[1].text).toEqual(["Keep all user constraints."]);
  expect(result.context.source_instructions).toBe("");
  expect(JSON.stringify(body)).toBe(before);
});

test.each([undefined, null, "at_fixture", ""])("Responses Lite optional id %j is recognized but never exposed", id => {
  const item: Record<string, unknown> = { type: "additional_tools", role: "developer", tools: [] };
  if (id !== undefined) item.id = id;
  expect(isResponsesLiteAdditionalToolsEnvelope(item)).toBe(true);
  expect(publicContextAncestryKnown({ input: [item, ...request().input] })).toBe(true);
  const result = astraJevPublicContext(request([item]), true);
  expect("context" in result).toBe(true); expect(JSON.stringify(result)).not.toContain("at_fixture");
});

test.each([
  { name: "wrong role", change: { role: "user" } },
  { name: "missing role", change: { role: undefined } },
  { name: "missing tools", change: { tools: undefined } },
  { name: "non-array tools", change: { tools: {} } },
  { name: "invalid id", change: { id: 1 } },
  { name: "unknown envelope field", change: { private_metadata: "withheld_fixture" } },
  { name: "control extension", change: { configuration_update: { reasoning: { effort: "low" } } } },
  { name: "content extension", change: { content: "Do not silently lose this unknown field." } },
  { name: "unknown item type", change: { type: "additional_tools_future" } },
])("Responses Lite $name is refused by both gates without changing its transport collector", ({ change }) => {
  const item = { ...liteDeclaration(), ...change }; const body = { input: [item, ...request().input] };
  expect(isResponsesLiteAdditionalToolsEnvelope(item)).toBe(false);
  expect(publicContextAncestryKnown(body)).toBe(false);
  expect(astraJevPublicContext(body, true)).toEqual({ reason: "unsupported_item" });
  // New strict predicate must not tighten the existing general-purpose collector.
  const expected = item.type === "additional_tools" && Array.isArray(item.tools) ? [item.tools] : [];
  expect(collectResponsesToolGroups(body)).toEqual(expected);
});

test("Responses Lite arbitrary declaration JSON is omitted without traversal or semantic guesses", () => {
  const tools: unknown[] = [null, 1, "private_long_fixture".repeat(100_000), { type: "configuration_update", encrypted_content: "private_blob_fixture" }];
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 2000; i++) deep = { nested: deep };
  tools.push(deep, Object.defineProperty({}, "private_data", { enumerable: true, get() { throw new Error("declaration children must not be read"); } }));
  const declaration = { type: "additional_tools", role: "developer", tools };
  const body = { input: [declaration, ...request().input] };
  expect(isResponsesLiteAdditionalToolsEnvelope(declaration)).toBe(true);
  expect(publicContextAncestryKnown(body)).toBe(true);
  const result = astraJevPublicContext(body, true);
  expect("context" in result).toBe(true); expect(JSON.stringify(result)).not.toContain("private_");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
  expect(astraJevPublicContext({ input: [declaration] }, true)).toEqual({ reason: "no_public_goal" });
  expect(astraJevPublicContext({ input: [declaration, { role: "user", content: "Required constraint. ".repeat(ASTRA_JEV_STATE_BYTES) }] }, true))
    .toEqual({ reason: "context_budget" });
  expect(astraJevPublicContext({ input: Array(PUBLIC_CONTEXT_SCAN_ITEMS + 1).fill(declaration) }, true)).toEqual({ reason: "context_budget" });
});
