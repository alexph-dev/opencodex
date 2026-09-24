import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearResponseStateMemoryForTests } from "../../src/responses/state";
import { astraJevPublicContext } from "../../src/server/responses/astra-jev-context";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { astraJevSizedProfile } from "../helpers/astra-jev-sized-profile";
import type { ServerWebSocket } from "bun";
import type { WsData } from "../../src/server/ws-bridge";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { astraJevLogDiagnostic } from "../../src/server/responses/astra-jev-types";

// Synthetic continuation of the existing measured-size fixture, never a transcript.
function repeatedProfile() {
  const body = astraJevSizedProfile();
  body.reasoning.effort = "medium";
  for (let turn = 0; turn < 3; turn++) {
    body.input.push(structuredClone(body.input[1]), structuredClone(body.input[2]),
      { type: "message", role: "user", content: `Continuation ${turn}: inspect the fixture, preserve all files.` },
      { type: "function_call", name: "fixture_read", call_id: `fixture_${turn}`, arguments: '{"path":"fixture"}' },
      { type: "function_call_output", call_id: `fixture_${turn}`, output: "Fixture read completed." });
  }
  return body;
}

function distinctProtectedProfile() {
  const body = astraJevSizedProfile();
  body.reasoning.effort = "medium";
  body.instructions = "Current source instructions: preserve the synthetic fixture and make no live changes.";
  body.input = [];
  const developerLengths = [21245, 47082, 19147, 32091, 30016, 21400, 23722, 1400];
  const userLengths = [28947, 23009, 1800, 1900, 2000, 2100, 2200, 2300];
  const text = (prefix: string, length: number) => (prefix + " distinct protected fixture. ".repeat(length)).slice(0, length);
  for (let index = 0; index < 8; index++) {
    body.input.push({ type: "message", role: "developer", content: [{ type: "input_text",
      text: text(`Developer protected ${index}: `, developerLengths[index]) }] });
    const content: Array<Record<string, unknown>> = [{ type: "input_text",
      text: text(`User protected ${index}: `, userLengths[index]) }];
    if (index === 0) content.push(
      { type: "input_image", image_url: "data:image/png;base64,private_r3_image_1" },
      { type: "input_image", image_url: "data:image/png;base64,private_r3_image_2" },
      { type: "input_image", image_url: "data:image/png;base64,private_r3_image_3" },
    );
    body.input.push({ type: "message", role: "user", content });
  }
  for (let index = 0; index < 170; index++) {
    body.input.push({ type: "message", role: "assistant", content: `Historical assistant observation ${index}.` });
  }
  body.input.push(
    { type: "function_call", name: "fixture_read", call_id: "r3_recent_failure", arguments: '{"path":"fixture"}' },
    { type: "function_call_output", call_id: "r3_recent_failure", status: "failed", output: "Synthetic recent read failed." },
    { type: "message", role: "developer", content: "Current developer fixture instruction: preserve all files." },
    { type: "message", role: "user", content: "Current text-only goal: inspect the synthetic failure without changing files." },
  );
  return body;
}

type Row = Record<string, unknown>;
// Independent inverse checks the representation, ordering, role and full exact text.
function expand(history: Row[]): Row[] {
  const references = new Map<string, Row>();
  return history.map(row => {
    const { context_message_id: id, ...plain } = row;
    if (row.type === "message_repeat") {
      expect(typeof id).toBe("string");
      const original = references.get(String(id));
      expect(original).toBeDefined();
      expect(original!.role).toBe(row.role);
      return structuredClone(original!);
    }
    if (id !== undefined) {
      expect(row.type).toBe("message");
      expect(references.has(String(id))).toBe(false);
      references.set(String(id), plain);
    }
    return plain;
  });
}

const realFetch = globalThis.fetch;
const savedEnabled = process.env.OCX_ASTRA_JEV_ENABLED;
const savedKey = process.env.TYPESAFE_API_KEY;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxy: Array<string | undefined>;
let releaseSpendHome = () => {};
const evaluated: Row[] = [];
const sent: Row[] = [];
const ladder = ["low", "medium", "high", "xhigh", "max", "ultra"];
let choice = "low";
let evaluatorReply: (() => Response | Promise<Response>) | undefined;
let retryNative = false;
const settings: OcxConfig = { port: 0, defaultProvider: "openai", providers: { openai: {
  adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
  codexAccountMode: "direct", upstreamWebsocket: false, modelAliases: { "gpt-6-astra": "Astra-Jev" },
} } };

beforeEach(() => {
  releaseSpendHome = acquireOwnedSpendHome(); clearResponseStateMemoryForTests();
  evaluated.length = 0; sent.length = 0;
  choice = "low"; evaluatorReply = undefined; retryNative = false;
  savedProxy = proxyKeys.map(key => process.env[key]);
  for (const key of proxyKeys) delete process.env[key];
  process.env.OCX_ASTRA_JEV_ENABLED = "1"; process.env.TYPESAFE_API_KEY = "fixture";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const body = await request.json() as Row;
    if (request.url === "https://api.typesafe.ai/v1/systemone") {
      expect(request.headers.get("authorization")).toBe("Bearer fixture");
      evaluated.push(body);
      if (evaluatorReply) return evaluatorReply();
      return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 25000 }, answers: { effort: {
        type: "choice", choice, confidence: 0.1,
        probabilities: Object.fromEntries(ladder.map(effort => [effort, effort === choice ? 1 : 0])),
      } } });
    }
    if (request.url !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("unexpected fixture destination");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-native");
    sent.push(body);
    if (retryNative && sent.length === 1) return new Response("fixture retry", { status: 503 });
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: `resp_repeat_fixture_${sent.length}`, status: "completed", output: [],
      usage: { input_tokens: 2, output_tokens: 1 },
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});

afterEach(() => {
  releaseSpendHome(); clearResponseStateMemoryForTests(); globalThis.fetch = realFetch;
  proxyKeys.forEach((key, index) => {
    if (savedProxy[index] === undefined) delete process.env[key]; else process.env[key] = savedProxy[index];
  });
  if (savedEnabled === undefined) delete process.env.OCX_ASTRA_JEV_ENABLED; else process.env.OCX_ASTRA_JEV_ENABLED = savedEnabled;
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
});

async function invoke(body: unknown, signal?: AbortSignal) {
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-native" },
    body: JSON.stringify(body), signal,
  }), settings, log);
  await response.text(); return { response, log };
}

test("long full-home continuation evaluates once without losing repeated protected messages", async () => {
  const body = repeatedProfile(); const before = JSON.stringify(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "0";
  expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body);
  expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(1);
  expect(result.log.astraJev).toMatchObject({ requestedBaseline: "medium", evaluatorChoice: "low",
    finalEffort: "medium", status: "skipped", reason: "referenced_downshift_veto",
    selectionMode: "referenced", repeatedMessages: 6 });
  expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]));
  expect(JSON.stringify(body)).toBe(before);
  const state = evaluated[0].state as { history: Row[] };
  const history = expand(state.history);
  const messages = history.filter(row => row.type === "message");
  const expected = body.input.filter(row => row.type === "message").map(row => ({ type: "message", role: row.role,
    text: typeof row.content === "string" ? [row.content] : (row.content as Array<{ text: string }>).map(part => part.text) }));
  expect(messages).toEqual(expected);
  expect(history.map(row => row.type)).toEqual(body.input.map(row => row.type === "additional_tools" ? "tool_declarations_omitted" : row.type));
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(96 * 1024);
  expect(Buffer.byteLength(JSON.stringify(evaluated[0]))).toBeLessThanOrEqual(112 * 1024);
  expect(JSON.stringify(evaluated[0])).not.toContain("private_declaration_sentinel");
  expect(JSON.stringify(result.log.astraJev)).not.toContain("Fixture constraint");
  expect(astraJevLogDiagnostic(result.log.astraJev)).toMatchObject({ repeatedMessages: 6 });
  expect(astraJevLogDiagnostic({ ...result.log.astraJev, repeatedMessages: "private_fixture" })).toBeUndefined();
  choice = "high";
  const raised = await invoke(body);
  expect(raised.response.status).toBe(200);
  expect(evaluated).toHaveLength(2);
  expect(raised.log.astraJev).toMatchObject({ requestedBaseline: "medium", evaluatorChoice: "high",
    finalEffort: "high", status: "applied", reason: "selected", selectionMode: "referenced", repeatedMessages: 6 });
  expect((sent[2].reasoning as { effort?: string }).effort).toBe("high");
});

test("a changed constraint in the middle is never mistaken for an exact repetition", async () => {
  const body = repeatedProfile();
  const changed = body.input[5].content as Array<{ text: string }>;
  changed[0].text = changed[0].text.slice(0, 10000) + "Distinct constraint: do not execute tools." + changed[0].text.slice(10000);
  const before = JSON.stringify(body);
  const result = await invoke(body);
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(result.log.astraJev).toMatchObject({ evaluatorChoice: "low", finalEffort: "medium",
    status: "skipped", reason: "sampled_downshift_veto", selectionMode: "sampled",
    repeatedMessages: 0 });
  expect(JSON.stringify((evaluated[0].state as { history: Row[] }).history)).not.toContain("message_repeat");
  expect(JSON.stringify(body)).toBe(before);
});

test("historical image parts stay private but no longer block a long repeated-text evaluation", async () => {
  const body = repeatedProfile();
  body.input.splice(3, 0, { type: "message", role: "user", content: [
    { type: "input_text", text: "Historical fixture note; image meaning is intentionally unavailable." },
    { type: "input_image", image_url: "data:image/png;base64,private_fixture_bytes_1" },
    { type: "input_image", image_url: "data:image/png;base64,private_fixture_bytes_2" },
    { type: "input_image", image_url: "data:image/png;base64,private_fixture_bytes_3" },
  ] });
  body.input.push({ type: "message", role: "user", content: "Current text-only goal: inspect the fixture without changing files." });
  const before = JSON.stringify(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "0";
  expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  choice = "low";
  const result = await invoke(body);
  expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(1);
  expect(JSON.stringify(evaluated[0])).not.toContain("private_fixture_bytes");
  expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]));
  expect(JSON.stringify(body)).toBe(before);
  expect(result.log.astraJev).toMatchObject({
    requestedBaseline: "medium", evaluatorChoice: "low", finalEffort: "medium",
    status: "skipped", reason: "withheld_media_downshift_veto",
    selectionMode: "withheld", withheldMediaItems: 3,
  });
  choice = "high";
  const raised = await invoke(body);
  expect(raised.response.status).toBe(200);
  expect(evaluated).toHaveLength(2);
  expect(JSON.stringify(evaluated[1])).not.toContain("private_fixture_bytes");
  expect(raised.log.astraJev).toMatchObject({
    requestedBaseline: "medium", evaluatorChoice: "high", finalEffort: "high",
    status: "applied", reason: "selected", selectionMode: "withheld", withheldMediaItems: 3,
  });
  expect((sent[2].reasoning as { effort?: string }).effort).toBe("high");
});

test("distinct 250KB protected history samples whole messages and reaches an upshift-only evaluator decision", async () => {
  const body = distinctProtectedProfile(); const before = JSON.stringify(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "0";
  expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  choice = "high";
  const result = await invoke(body);
  expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(1);
  expect(JSON.stringify(evaluated[0])).not.toContain("private_r3_image");
  expect(result.log.astraJev).toMatchObject({
    requestedBaseline: "medium", evaluatorChoice: "high", finalEffort: "high",
    status: "applied", reason: "selected", selectionMode: "sampled", withheldMediaItems: 3,
  });
  expect(result.log.astraJev?.protectedBytes).toBeGreaterThan(250 * 1024);
  expect(result.log.astraJev?.omittedProtectedMessages).toBeGreaterThan(0);
  expect(result.log.astraJev?.omittedProtectedBytes).toBeGreaterThan(0);
  const state = evaluated[0].state as { source_instructions: string; history: Row[]; omissions: string[] };
  expect(state.source_instructions).toBe(body.instructions);
  expect(JSON.stringify(state.history)).toContain("Current developer fixture instruction");
  expect(JSON.stringify(state.history)).toContain("Current text-only goal");
  expect(JSON.stringify(state.history)).toContain("Developer protected 7");
  expect(JSON.stringify(state.history)).toContain("User protected 7");
  const protectedMarkers = state.history.filter(row => row.type === "history_omitted"
    && typeof row.omitted_protected_messages === "number");
  expect(protectedMarkers.length).toBeGreaterThan(0);
  expect(protectedMarkers.reduce((sum, row) => sum + Number(row.omitted_protected_messages), 0))
    .toBe(result.log.astraJev?.omittedProtectedMessages);
  expect(protectedMarkers.reduce((sum, row) => sum + Number(row.omitted_protected_bytes), 0))
    .toBe(result.log.astraJev?.omittedProtectedBytes);
  expect(state.omissions.join(" ")).toContain("Older protected messages may be omitted only whole");
  expect(JSON.stringify(sent[1])).toBe(JSON.stringify({
    ...sent[0], reasoning: { ...(sent[0].reasoning as Record<string, unknown>), effort: "high" },
  }));
  expect(JSON.stringify(body)).toBe(before);
  choice = "low";
  const lowered = await invoke(body);
  expect(lowered.response.status).toBe(200);
  expect(evaluated).toHaveLength(2);
  expect(lowered.log.astraJev).toMatchObject({
    requestedBaseline: "medium", evaluatorChoice: "low", finalEffort: "medium",
    status: "skipped", reason: "withheld_media_downshift_veto",
    selectionMode: "sampled", withheldMediaItems: 3,
  });
  expect(JSON.stringify(sent[2])).toBe(JSON.stringify(sent[0]));
});

test("eight growing full-home invocations each reach the evaluator without rewriting tool history", async () => {
  const body = astraJevSizedProfile(); body.reasoning.effort = "medium";
  for (let turn = 0; turn < 8; turn++) {
    const before = JSON.stringify(body);
    const result = await invoke(body);
    expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(turn + 1);
    expect(result.log.astraJev).toMatchObject(turn === 0
      ? { evaluatorChoice: "low", finalEffort: "low", status: "applied",
          selectionMode: "full", repeatedMessages: 0 }
      : { evaluatorChoice: "low", finalEffort: "medium", status: "skipped",
          reason: "referenced_downshift_veto", selectionMode: "referenced", repeatedMessages: turn * 2 });
    expect(JSON.stringify(body)).toBe(before);
    expect(JSON.stringify(sent[turn])).not.toContain("context_message_id");
    expect((sent[turn].input as Row[]).filter(row => row.type === "function_call_output")).toHaveLength(turn);
    body.input.push(structuredClone(body.input[1]), structuredClone(body.input[2]),
      { type: "message", role: "user", content: `Turn ${turn}: keep the fixture unchanged.` },
      { type: "function_call", name: "fixture_read", call_id: `growing_${turn}`, arguments: '{"path":"fixture"}' },
      { type: "function_call_output", call_id: `growing_${turn}`, output: "Read-only fixture result." });
  }
}, 10_000);

test("opaque or incomplete repeated contexts still fail closed before evaluation", () => {
  for (const control of [{ prompt: { id: "fixture" } }, { context_management: [] }]) {
    expect(astraJevPublicContext({ ...repeatedProfile(), ...control }, true)).toHaveProperty("reason");
  }
  expect(astraJevPublicContext(repeatedProfile(), false)).toEqual({ reason: "opaque_ancestry" });
});

test.each(["user", "system", "developer"])("lossless references retain Unicode, parts, chronology and %s role", role => {
  const message = { role, content: [{ type: "input_text", text: 'Constraint Ω. '.repeat(5000) },
    { type: "input_text", text: 'Keep "quoted" and \\escaped\nconstraints 🚦.' }] };
  const body = { input: [message, { role: "assistant", content: "Read only; no action taken." },
    structuredClone(message), { role: "user", content: "Continue without edits." }] };
  const before = JSON.stringify(body);
  const projected = astraJevPublicContext(body, true);
  expect(projected).toHaveProperty("context");
  if (!("context" in projected)) throw new Error("expected complete projection");
  expect(projected.sampled).toBeUndefined();
  const history = expand(projected.context.history);
  expect(history[0]).toEqual({ type: "message", role, text: message.content.map(part => part.text) });
  expect(history[2]).toEqual(history[0]);
  expect(history[1]).toMatchObject({ role: "assistant", text: ["Read only; no action taken."] });
  expect(JSON.stringify(body)).toBe(before);
});

test("same text with a different role cannot reuse a protected message", () => {
  const text = 'Constraint Ω. '.repeat(5000);
  expect(astraJevPublicContext({ input: [{ role: "developer", content: text },
    { role: "user", content: text }] }, true)).toEqual({ reason: "context_budget" });
});

test("caller-authored references are rejected and caller anchor fields cannot enter the projection", () => {
  const body = repeatedProfile();
  for (const row of body.input) if (row.type === "message") row.context_message_id = "private_fake_reference";
  const projected = astraJevPublicContext(body, true);
  expect(projected).toHaveProperty("context");
  expect(JSON.stringify(projected)).not.toContain("private_fake_reference");
  body.input.push({ type: "message_repeat", role: "user", context_message_id: "m2" });
  expect(astraJevPublicContext(body, true)).toEqual({ reason: "unsupported_item" });
});

test.each(["high", "low"])("reference overflow falls back to whole-message sampling with the existing %s choice policy", async selected => {
  choice = selected;
  const body = repeatedProfile();
  for (let index = 0; index < 360; index++) body.input.push({ type: "message", role: "assistant",
    content: `Observation ${index}. ` + "Public fixture context. ".repeat(20) });
  body.input.push({ type: "message", role: "user", content: "Check the last fixture; do not edit." });
  const result = await invoke(body);
  expect(evaluated).toHaveLength(1);
  const expectedEffort = selected === "low" ? "medium" : "high";
  expect(result.log.astraJev).toMatchObject({ evaluatorChoice: selected, finalEffort: expectedEffort,
    selectionMode: "sampled", repeatedMessages: 0,
    status: selected === "low" ? "skipped" : "applied",
    reason: selected === "low" ? "sampled_downshift_veto" : "selected" });
  const history = (evaluated[0].state as { history: Row[] }).history;
  expect(history.some(row => row.type === "message_repeat")).toBe(false);
  expect(history.some(row => row.type === "message" && row.role === "developer")).toBe(true);
  expect(JSON.stringify(history)).toContain("Check the last fixture; do not edit.");
  expect(history.some(row => row.type === "history_omitted")).toBe(true);
  expect(result.log.astraJev?.omittedProtectedMessages).toBeGreaterThan(0);
});

test("repeated-context evaluator failure keeps the full native baseline", async () => {
  evaluatorReply = () => new Response("private_error_fixture", { status: 422 });
  const result = await invoke(repeatedProfile());
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(1);
  expect(result.log.astraJev).toMatchObject({ status: "failed", reason: "http_error", evaluatorChoice: null,
    finalEffort: "medium", repeatedMessages: 6 });
  expect(JSON.stringify(result.log.astraJev)).not.toContain("private_error_fixture");
});

test("native retries reuse one reference-encoded decision, not a truncated request", async () => {
  retryNative = true;
  const result = await invoke(repeatedProfile());
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]); expect(JSON.stringify(sent)).not.toContain("context_message_id");
});

async function until(condition: () => boolean) {
  for (let count = 0; count < 1500; count++) { if (condition()) return; await Bun.sleep(2); }
  throw new Error("fixture did not settle");
}

test("cancelled reference evaluation never dispatches late inference or poisons its successor", async () => {
  let release!: (response: Response) => void;
  evaluatorReply = () => new Promise<Response>(resolve => { release = resolve; });
  const controller = new AbortController(); const running = invoke(repeatedProfile(), controller.signal);
  await until(() => evaluated.length === 1); controller.abort();
  expect((await running).response.status).toBe(499); expect(sent).toHaveLength(0);
  release(new Response("late fixture", { status: 422 })); await Bun.sleep(5);
  expect(sent).toHaveLength(0);
  evaluatorReply = undefined;
  const ordinary = repeatedProfile(); ordinary.model = "gpt-6-astra";
  expect((await invoke(ordinary)).response.status).toBe(200);
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(1);
  expect(sent[0].reasoning).toMatchObject({ effort: "medium" });
});

test("an ordinary parent resumes through WS with native history, not evaluator references", async () => {
  const parent = repeatedProfile(); parent.model = "gpt-6-astra";
  expect((await invoke(parent)).response.status).toBe(200); expect(evaluated).toHaveLength(0);
  const handler = createWebsocketHandler({ config: settings, deps: {} } as ServeOptionsContext);
  const frames: Row[] = [];
  const ws = { readyState: 1, data: { headers: new Headers({ authorization: "Bearer fixture-native" }) } as WsData,
    send(text: string) { frames.push(JSON.parse(text)); return 1; },
    close() { handler.close(ws, 1000, "fixture complete"); },
  } as unknown as ServerWebSocket<WsData>;
  try {
    handler.message(ws, JSON.stringify({ ...parent, type: "response.create", model: "openai/Astra-Jev",
      previous_response_id: "resp_repeat_fixture_1", input: [{ role: "user", content: "Continue read-only." }] }));
    await until(() => frames.some(row => row.type === "response.completed" || row.type === "error"));
    expect(frames.at(-1)?.type).toBe("response.completed");
    expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).not.toContain("context_message_id");
    expect((sent[1].input as Row[]).filter(row => row.type === "function_call_output")).toHaveLength(3);
    const history = expand((evaluated[0].state as { history: Row[] }).history);
    expect(history.filter(row => row.type === "message" && row.role === "developer")).toHaveLength(8);
    expect(history.at(-1)).toMatchObject({ role: "user", text: ["Continue read-only."] });
  } finally {
    handler.close(ws, 1000, "fixture complete"); await until(() => ws.data.cancel === undefined);
  }
});
