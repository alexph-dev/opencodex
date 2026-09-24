import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";
import type { ServerWebSocket } from "bun";
import type { WsData } from "../../src/server/ws-bridge";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { rememberResponseState, clearResponseStateMemoryForTests, runPendingResponseStatePersistForTests } from "../../src/responses/state";
import { addFinalRequestLog, addRequestLog, getRequestLogEntries, clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { readUsageEntries } from "../../src/usage/log";
import { parseRequest } from "../../src/responses/parser";
import { captureRouteStaticPolicy, routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { captureAstraJevInvocation, applyAstraJevEffort } from "../../src/server/responses/astra-jev";
import { handleManagementAPI } from "../../src/server/management-api";
import { astraJevSizedProfile } from "../helpers/astra-jev-sized-profile";
import { astraJevLogDiagnostic } from "../../src/server/responses/astra-jev-types";
import { ASTRA_JEV_STATE_BYTES } from "../../src/server/responses/astra-jev-context";
import { failedExecution, historyWithMiddleFailures } from "../helpers/astra-jev-failure-history";

const endpoint = "https://api.typesafe.ai/v1/systemone";
const nativeUrl = "https://chatgpt.com/backend-api/codex/responses";
const alias = "openai/Astra-Jev";
const realFetch = globalThis.fetch;
const savedEnabled = process.env.OCX_ASTRA_JEV_ENABLED;
const savedKey = process.env.TYPESAFE_API_KEY;
const evaluated: Record<string, any>[] = [];
const sent: Record<string, any>[] = [];
const evaluatorHeaders: Headers[] = [];
const nativeHeaders: Headers[] = [];
const ladder = ["low", "medium", "high", "xhigh", "max", "ultra"];
let choices: string[] = [];
let evaluateReply: (request: Request) => Response | Promise<Response>;
let nativeReply: () => Response;
let releaseSpendHome = () => {};
const clients: Array<{ ws: ServerWebSocket<WsData>; handler: ReturnType<typeof createWebsocketHandler> }> = [];
const proxyNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let proxyEnv: Array<string | undefined>;
function answer(choice = "low") {
  return { model: "jev-1.13.0", usage: { input_tokens: 24000, output_tokens: 20 }, answers: { effort: { type: "choice", choice, confidence: 0.05,
    probabilities: Object.fromEntries(ladder.map(effort => [effort, effort === choice ? 1 : 0])),
  } } };
}
const completed = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
  id: `resp_fixture_${sent.length}`, status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 },
} })}\n\n`, { headers: { "content-type": "text/event-stream" } });
const config = (): OcxConfig => ({ port: 0, defaultProvider: "openai", providers: { openai: {
  adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
  codexAccountMode: "direct", upstreamWebsocket: false, modelAliases: { "gpt-6-astra": "Astra-Jev" },
} } });
const payload = (model = alias): Record<string, any> => ({
  model, stream: true, store: false, instructions: "Public source instructions: preserve user files.",
  input: [{ role: "user", content: "Read the known fixture once, without changing files." }],
  reasoning: { effort: "xhigh", summary: "none" },
  tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] }],
  parallel_tool_calls: true, text: { verbosity: "low" },
});
const request = (body: unknown, signal?: AbortSignal) => new Request("http://localhost/v1/responses", {
  method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" },
  body: JSON.stringify(body), signal,
});

test("sampled middle failure evidence reaches the HTTP evaluator and permits escalation", async () => {
  const body = { ...payload(), ...historyWithMiddleFailures(), reasoning: { effort: "medium", summary: "none" } };
  const before = JSON.stringify(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "0";
  expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  evaluateReply = () => {
    // Deterministic transport evidence, not a model-quality claim: escalation needs both facts.
    const failed = evaluated.at(-1)!.state.history.filter((row: { status?: string }) => row.status === "failed");
    return Response.json(answer(failed.length === 2 ? "high" : "medium"));
  };
  const result = await invoke(body);
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(evaluated[0].state.history.filter((row: { status?: string }) => row.status === "failed")
    .map((row: { call_id: string }) => row.call_id)).toEqual(["recent_a_fixture", "recent_b_fixture"]);
  expect(result.log.astraJev).toMatchObject({ requestedBaseline: "medium", evaluatorChoice: "high",
    finalEffort: "high", status: "applied", selectionMode: "sampled" });
  expect(JSON.stringify(sent[1]) === JSON.stringify({ ...sent[0], reasoning: { ...sent[0].reasoning, effort: "high" } })).toBe(true);
  expect(nativeHeaders[1].get("authorization")).toBe("Bearer fixture");
  expect(Buffer.byteLength(JSON.stringify(evaluated[0]))).toBeLessThanOrEqual(112 * 1024);
  expect(JSON.stringify(body) === before).toBe(true);
});

test.each(["high", "low"])("sampled failure anchors survive WS while choice %s retains the downshift guard", async choice => {
  const body = { ...payload(), ...historyWithMiddleFailures(), reasoning: { effort: "medium", summary: "none" } };
  process.env.OCX_ASTRA_JEV_ENABLED = "0"; expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1"; choices = [choice];
  const client = wsClient(); client.send(body);
  await until(() => client.frames.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(client.frames.at(-1)?.type).toBe("response.completed");
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(2);
  expect(evaluated[0].state.history.filter((row: { status?: string }) => row.status === "failed")
    .map((row: { call_id: string }) => row.call_id)).toEqual(["recent_a_fixture", "recent_b_fixture"]);
  const expectedEffort = choice === "high" ? "high" : "medium";
  expect(JSON.stringify(sent[1]) === JSON.stringify({ ...sent[0], reasoning: { ...sent[0].reasoning, effort: expectedEffort } })).toBe(true);
  expect(nativeHeaders[1].get("authorization")).toBe("Bearer fixture-native");
});

test("oversized failed execution anchors keep native baseline without an evaluator attempt", async () => {
  const large = failedExecution("large_fixture");
  large.splice(1, 0, { role: "assistant", content: "Public interval explanation. ".repeat(4000) });
  const body = { ...payload(), ...historyWithMiddleFailures([large, failedExecution("recent_fixture")]) };
  const before = JSON.stringify(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "0"; expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(sent).toHaveLength(2);
  expect(JSON.stringify(sent[1]) === JSON.stringify(sent[0])).toBe(true);
  expect(JSON.stringify(body) === before).toBe(true);
  expect(result.log.astraJev).toMatchObject({ status: "skipped", reason: "context_budget",
    budgetOwner: "required_state", evaluatorChoice: null, requestedBaseline: "xhigh", finalEffort: "xhigh" });
});

test("measured-size HTTP initial and tool continuation evaluate complete projections with usage", async () => {
  evaluateReply = () => Response.json({ ...answer("low"), usage: { input_tokens: 24000, output_tokens: 20 } });
  for (const continuation of [false, true]) {
    const body = astraJevSizedProfile(continuation); const before = JSON.stringify(body); const start = sent.length;
    process.env.OCX_ASTRA_JEV_ENABLED = "0";
    expect((await invoke(body)).response.status).toBe(200);
    process.env.OCX_ASTRA_JEV_ENABLED = "1";
    const result = await invoke(body); expect(result.response.status).toBe(200);
    expect(evaluated).toHaveLength(continuation ? 2 : 1);
    expect(JSON.stringify(sent[start + 1]) === JSON.stringify({ ...sent[start], reasoning: { ...sent[start].reasoning, effort: "low" } })).toBe(true);
    const evaluatedBody = evaluated.at(-1)!;
    expect(evaluatedBody.state.history.some((row: { type: string }) => row.type === "history_omitted")).toBe(false);
    expect(evaluatedBody.state.history).toHaveLength(body.input.length);
    expect(Buffer.byteLength(JSON.stringify(evaluatedBody.state))).toBeLessThanOrEqual(96 * 1024);
    expect(Buffer.byteLength(JSON.stringify(evaluatedBody))).toBeLessThanOrEqual(112 * 1024);
    expect(JSON.stringify(evaluatedBody).includes("private_declaration_sentinel")).toBe(false);
    expect(JSON.stringify(body) === before).toBe(true);
    expect(result.log.astraJev).toMatchObject({ requestedBaseline: "high", evaluatorChoice: "low", finalEffort: "low",
      status: "applied", selectionMode: "full", providerInputTokens: 24000, evaluatorModel: "jev-1.13.0", budgetOwner: null });
    expect(result.log.astraJev?.stateBytes).toBe(Buffer.byteLength(JSON.stringify(evaluatedBody.state)));
    expect(result.log.astraJev?.requestBytes).toBe(Buffer.byteLength(JSON.stringify(evaluatedBody)));
    expect(result.log.astraJev?.omittedItems).toBe(0);
    expect(result.log.astraJev?.protectedBytes).toBeGreaterThan(89900);
    expect(result.log.astraJev?.preprocessingMs).toBeGreaterThanOrEqual(0);
  }
});

test.each(["missing_usage", "malformed_usage", "excess_tokens", "invalid_choice", "invalid_model", "rejected", "network"])(
  "expanded HTTP %s retains complete native baseline after one evaluator attempt", async kind => {
    const body = astraJevSizedProfile();
    process.env.OCX_ASTRA_JEV_ENABLED = "0"; expect((await invoke(body)).response.status).toBe(200);
    process.env.OCX_ASTRA_JEV_ENABLED = "1";
    evaluateReply = () => {
      if (kind === "rejected") return new Response("private_error_sentinel", { status: 422 });
      if (kind === "network") throw new Error("private_error_sentinel");
      const response: Record<string, any> = answer();
      if (kind === "missing_usage") delete response.usage;
      if (kind === "malformed_usage") response.usage.input_tokens = "24000";
      if (kind === "excess_tokens") response.usage.input_tokens = 30001;
      if (kind === "invalid_choice") response.answers.effort.probabilities.high = 1;
      if (kind === "invalid_model") response.model = "private_model_sentinel";
      return Response.json(response);
    };
    const result = await invoke(body); expect(result.response.status).toBe(200);
    expect(evaluated).toHaveLength(1); expect(JSON.stringify(sent[1]) === JSON.stringify(sent[0])).toBe(true);
    const reason = kind.includes("usage") ? "invalid_usage" : kind === "excess_tokens" ? "provider_token_budget"
      : kind === "rejected" ? "http_error" : kind === "network" ? "network" : "invalid_response";
    expect(result.log.astraJev).toMatchObject({ requestedBaseline: "high", evaluatorChoice: null, finalEffort: "high",
      status: "failed", reason, selectionMode: "full" });
    expect(JSON.stringify(result.log.astraJev).includes("private_")).toBe(false);
    if (kind === "excess_tokens") expect(result.log.astraJev).toMatchObject({ providerInputTokens: 30001, budgetOwner: "provider_tokens" });
  },
);

test("expanded WS continuation, forwarding retry and High choice preserve one decision", async () => {
  const parent = astraJevSizedProfile(); parent.model = "gpt-6-astra";
  expect((await invoke(parent)).response.status).toBe(200); expect(evaluated).toHaveLength(0);
  choices = ["high"];
  nativeReply = () => sent.length === 2 ? new Response("retry fixture", { status: 503 }) : completed();
  const client = wsClient();
  const child = astraJevSizedProfile(true);
  client.send({ ...child, previous_response_id: "resp_fixture_1", input: child.input.slice(5) });
  await until(() => client.frames.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(client.frames.at(-1)?.type).toBe("response.completed"); expect(evaluated).toHaveLength(1);
  expect(sent).toHaveLength(3); expect(JSON.stringify(sent[2]) === JSON.stringify(sent[1])).toBe(true);
  expect(sent[2].reasoning.effort).toBe("high");
  expect(evaluated[0].state.history).toHaveLength(7);
  expect(evaluated[0].state.history.some((row: { type: string }) => row.type === "history_omitted")).toBe(false);
});

test("expanded caller cancellation still prevents any native dispatch", async () => {
  const controller = new AbortController();
  let release!: (response: Response) => void;
  evaluateReply = () => new Promise<Response>(resolve => { release = resolve; });
  const running = invoke(astraJevSizedProfile(), config(), controller.signal);
  await until(() => evaluated.length === 1); controller.abort();
  const result = await running; expect(result.response.status).toBe(499); expect(sent).toHaveLength(0);
  release(Response.json(answer("low"))); await Bun.sleep(5); expect(sent).toHaveLength(0);
  expect(result.log.astraJev?.status).toBe("cancelled");
});

test.each(["disabled", "ordinary"])("expanded %s request never invokes evaluator", async mode => {
  const body = astraJevSizedProfile();
  if (mode === "ordinary") body.model = "gpt-6-astra";
  else process.env.OCX_ASTRA_JEV_ENABLED = "0";
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(sent[0].reasoning.effort).toBe("high");
});

test("expanded protected overflow reports its budget owner and never truncates upstream", async () => {
  const body = astraJevSizedProfile();
  // The latest user message is a mandatory recency anchor under protected-text
  // sampling; make that anchor itself too large rather than relying on an old
  // historical developer message staying mandatory.
  (body.input[4].content as Array<{ text: string }>)[0].text += "more required text. ".repeat(4000);
  process.env.OCX_ASTRA_JEV_ENABLED = "0"; expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(0);
  expect(JSON.stringify(sent[1]) === JSON.stringify(sent[0])).toBe(true);
  expect(result.log.astraJev).toMatchObject({ reason: "context_budget", budgetOwner: "required_state", evaluatorChoice: null, finalEffort: "high" });
});

test("content-free measurement readback survives logs but never durable usage", async () => {
  const result = await invoke(astraJevSizedProfile());
  addFinalRequestLog("fixture_expanded_numbers", Date.now(), result.log, result.response.status);
  const entry = getRequestLogEntries().find(row => row.requestId === "fixture_expanded_numbers")!;
  const req = new Request("http://localhost/api/logs?model=gpt-6-astra&limit=20", { headers: { host: "localhost" } });
  const response = await handleManagementAPI(req, new URL(req.url), config());
  const body = await response!.json() as { logs: Array<{ requestId: string; astraJev?: unknown }> };
  expect(body.logs.find(row => row.requestId === "fixture_expanded_numbers")?.astraJev).toEqual(entry.astraJev);
  expect(entry.astraJev).toMatchObject({ selectionMode: "full", omittedItems: 0, providerInputTokens: 24000, evaluatorModel: "jev-1.13.0" });
  expect(readUsageEntries().find(row => row.requestId === "fixture_expanded_numbers")).not.toHaveProperty("astraJev");
  const raw = { ...entry.astraJev, payload: "private_data_sentinel" };
  expect(JSON.stringify(astraJevLogDiagnostic(raw)).includes("private_data_sentinel")).toBe(false);
  for (const invalid of [{ stateBytes: -1 }, { providerInputTokens: "24000" }, { preprocessingMs: Infinity },
    { budgetOwner: "private_data_sentinel" }, { evaluatorModel: "secret_sentinel" }, { selectionMode: { toString: () => "full" } }]) {
    expect(astraJevLogDiagnostic({ ...raw, ...invalid })).toBeUndefined();
  }
});
beforeEach(() => {
  evaluated.length = 0; sent.length = 0; evaluatorHeaders.length = 0; nativeHeaders.length = 0; choices = [];
  releaseSpendHome = acquireOwnedSpendHome(); clearResponseStateMemoryForTests(); clearRequestLogsForTests();
  proxyEnv = proxyNames.map(key => process.env[key]); for (const key of proxyNames) delete process.env[key];
  evaluateReply = () => Response.json(answer(choices.shift() ?? "low")); nativeReply = completed;
  process.env.OCX_ASTRA_JEV_ENABLED = "1"; process.env.TYPESAFE_API_KEY = "fixture";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); const body = JSON.parse(await req.text());
    if (req.url === endpoint) {
      evaluated.push(body); evaluatorHeaders.push(req.headers);
      return evaluateReply(req);
    }
    if (req.url !== nativeUrl && req.url !== `${nativeUrl}/compact`) throw new Error("unexpected fixture destination");
    sent.push(body); nativeHeaders.push(req.headers);
    if (req.url.endsWith("/compact")) return Response.json({ object: "response.compaction", output: [], usage: { input_tokens: 1, output_tokens: 1 } });
    return nativeReply();
  }) as typeof fetch;
});
afterEach(async () => {
  try {
    for (const { ws, handler } of clients.splice(0)) { handler.close(ws, 1000, "fixture complete"); await until(() => ws.data.cancel === undefined); }
  } finally {
    releaseSpendHome();
    globalThis.fetch = realFetch; clearResponseStateMemoryForTests();
    proxyNames.forEach((key, index) => { if (proxyEnv[index] === undefined) delete process.env[key]; else process.env[key] = proxyEnv[index]; });
    if (savedEnabled === undefined) delete process.env.OCX_ASTRA_JEV_ENABLED; else process.env.OCX_ASTRA_JEV_ENABLED = savedEnabled;
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  }
});

async function until(condition: () => boolean) {
  for (let i = 0; i < 1500; i++) { if (condition()) return; await Bun.sleep(2); }
  throw new Error("fixture did not settle");
}
async function invoke(body = payload(), settings = config(), signal?: AbortSignal) {
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(body, signal), settings, log);
  const text = await response.text(); return { response, text, log };
}
function wsClient(settings = config()) {
  const handler = createWebsocketHandler({ config: settings, deps: {} } as ServeOptionsContext);
  const frames: Array<Record<string, any>> = [];
  const ws = { readyState: 1, data: { headers: new Headers({ authorization: "Bearer fixture-native" }) } as WsData,
    send(text: string) { frames.push(JSON.parse(text)); return 1; },
    close() { handler.close(ws, 1000, "fixture complete"); },
  } as unknown as ServerWebSocket<WsData>;
  clients.push({ ws, handler });
  return { ws, frames, send: (body: Record<string, unknown>) => handler.message(ws, JSON.stringify({ type: "response.create", ...body })) };
}

// Pinned native Responses Lite producer: declarations and base instructions are input items.
// Values are invented. No captured user content, tool schemas or credential is used.
function litePayload(model = alias): Record<string, any> {
  const body = payload(model);
  const tools = body.tools;
  tools[0].description = "private_declaration_fixture";
  tools[0].tools.push({ type: "custom", name: "apply_patch", description: "private_custom_fixture", format: { type: "text" } });
  tools.push({ type: "namespace", name: "mcp__fixture", tools: [{ type: "function", name: "find", defer_loading: true,
    parameters: { type: "object", properties: { query: { type: "string", default: "private_default_fixture" } } } }] });
  body.input = [
    { type: "additional_tools", role: "developer", id: "at_fixture", tools },
    { type: "message", role: "developer", id: "msg_fixture", content: [{ type: "input_text", text: body.instructions }],
      internal_chat_message_metadata_passthrough: { marker: "private_metadata_fixture" } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Read the fixture; do not change any files." }] },
  ];
  delete body.instructions; delete body.tools;
  body.reasoning.context = "all_turns";
  body.tool_choice = "auto"; body.include = ["reasoning.encrypted_content"];
  body.client_metadata = { marker: "private_client_fixture" }; body.access_programs = ["private_program_fixture"];
  return body;
}

function longLitePayload(model = alias) {
  const body = litePayload(model);
  for (let i = 0; i < 360; i++) body.input.push({ type: "message", role: "assistant",
    content: `Public observation ${i}. ` + "Offline analysis context. ".repeat(18) });
  body.input.push({ type: "message", role: "user", content: "Current fixture goal: inspect the failed check, no live changes." },
    { type: "function_call", name: "exec_command", call_id: "last_fixture_check", arguments: '{"cmd":"check fixture"}' },
    { type: "function_call_output", call_id: "last_fixture_check", output: "FAILED: fixture totals disagree." });
  body.reasoning.effort = "medium";
  return body;
}

test("sampled long Lite HTTP vetoes a downshift while forwarding the entire original native context", async () => {
  const body = longLitePayload(); const before = JSON.stringify(body);
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body);
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(sent[1]).toEqual(sent[0]);
  expect(JSON.stringify(body)).toBe(before);
  expect(Buffer.byteLength(JSON.stringify(evaluated[0]))).toBeLessThanOrEqual(112 * 1024);
  expect(evaluated[0].state.history.length).toBeLessThanOrEqual(256);
  expect(JSON.stringify(evaluated[0].state)).toContain("FAILED: fixture totals disagree.");
  expect(JSON.stringify(evaluated[0].state)).not.toContain("private_declaration_fixture");
  expect(evaluated[0].state.history.some((row: { type: string }) => row.type === "history_omitted")).toBe(true);
  expect(nativeHeaders[1].get("authorization")).toBe("Bearer fixture");
  expect(result.log.astraJev).toMatchObject({ requestedBaseline: "medium", evaluatorChoice: "low",
    finalEffort: "medium", status: "skipped", reason: "sampled_downshift_veto" });
  addFinalRequestLog("fixture_sampled_veto", Date.now(), result.log, result.response.status);
  const req = new Request("http://localhost/api/logs?model=gpt-6-astra&limit=20", { headers: { host: "localhost" } });
  const response = await handleManagementAPI(req, new URL(req.url), config());
  expect(response?.status).toBe(200);
  const readback = await response!.json() as { logs: Array<{ requestId: string; astraJev?: unknown }> };
  expect(readback.logs.find(row => row.requestId === "fixture_sampled_veto")?.astraJev).toEqual(result.log.astraJev);
  expect(readUsageEntries().find(row => row.requestId === "fixture_sampled_veto")).not.toHaveProperty("astraJev");
});

test("long ordinary parent remains evaluable through the shared WS continuation path", async () => {
  expect((await invoke(longLitePayload("gpt-6-astra"))).response.status).toBe(200);
  expect(evaluated).toHaveLength(0);
  choices = ["high"];
  const client = wsClient(); client.send({ ...litePayload(), reasoning: { effort: "medium" }, previous_response_id: "resp_fixture_1" });
  await until(() => client.frames.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(client.frames.at(-1)?.type).toBe("response.completed");
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(2);
  expect(sent[1].input.length).toBeGreaterThan(360); expect(sent[1].reasoning.effort).toBe("high");
  expect(JSON.stringify(evaluated[0].state)).toContain("FAILED: fixture totals disagree.");
  expect(nativeHeaders[1].get("authorization")).toBe("Bearer fixture-native");
});

test.each([
  { baseline: "high", choice: "low", final: "high", status: "skipped", reason: "sampled_downshift_veto" },
  { baseline: "medium", choice: "high", final: "high", status: "applied", reason: "selected" },
  { baseline: "high", choice: "high", final: "high", status: "applied", reason: "selected" },
  { baseline: "ultra", choice: "max", final: "max", status: "applied", reason: "selected" },
])("sampled effort $baseline to $choice uses the native inference ordering", async row => {
  const body = longLitePayload(); body.reasoning.effort = row.baseline; choices = [row.choice];
  const result = await invoke(body);
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(sent[0].reasoning.effort).toBe(row.final);
  expect(result.log.astraJev).toMatchObject({ requestedBaseline: row.baseline, evaluatorChoice: row.choice,
    finalEffort: row.final, status: row.status, reason: row.reason });
});

test("sampled context with no explicit baseline never guesses the native default", async () => {
  const body = longLitePayload(); delete body.reasoning.effort;
  delete process.env.OCX_ASTRA_JEV_ENABLED; expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body);
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(sent[1]).toEqual(sent[0]);
  expect(result.log.astraJev).toMatchObject({ requestedBaseline: "unset", evaluatorChoice: "low",
    status: "skipped", reason: "sampled_baseline_unknown" });
});

test("sampled veto is cached once across native retries", async () => {
  nativeReply = () => sent.length === 1 ? new Response("retry fixture", { status: 503 }) : completed();
  const result = await invoke(longLitePayload());
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.every(row => row.reasoning.effort === "medium")).toBe(true);
  expect(result.log.astraJev).toMatchObject({ evaluatorChoice: "low", finalEffort: "medium", reason: "sampled_downshift_veto" });
});

test.each(["pin", "cap"])("sampled veto does not override an authoritative native %s", async owner => {
  const settings = config();
  if (owner === "pin") settings.providers.openai.pinnedReasoningEffort = "low";
  else settings.effortCap = "low";
  const before = JSON.stringify(settings);
  const req = request(longLitePayload()); req.headers.set("x-openai-subagent", "collab_spawn");
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(req, settings, log); await response.text();
  expect(response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(sent[0].reasoning.effort).toBe("low");
  expect(log.astraJev).toMatchObject({ requestedBaseline: "medium", evaluatorChoice: "low",
    finalEffort: "low", status: "skipped", reason: "sampled_downshift_veto" });
  expect(JSON.stringify(settings)).toBe(before);
});

test("full projections retain downshifts despite caller sampling words or legacy tool clipping", async () => {
  const body = litePayload(); body.sampled = true;
  body.input.push({ role: "user", content: "The phrase history_omitted is fixture text, not policy state." },
    { type: "function_call_output", call_id: "fixture", output: "Public output line. ".repeat(1000) });
  const result = await invoke(body);
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(1);
  expect(evaluated[0].state).not.toHaveProperty("sampled");
  expect(evaluated[0].state.history.some((row: { type: string }) => row.type === "history_omitted")).toBe(false);
  expect(result.log.astraJev).toMatchObject({ requestedBaseline: "xhigh", evaluatorChoice: "low",
    finalEffort: "low", status: "applied", reason: "selected" });
});

test("sampled WS downshift remains vetoed at the shared handler boundary", async () => {
  const client = wsClient(); client.send(longLitePayload());
  await until(() => client.frames.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(client.frames.at(-1)?.type).toBe("response.completed");
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(1);
  expect(sent[0].reasoning.effort).toBe("medium");
  expect(nativeHeaders[0].get("authorization")).toBe("Bearer fixture-native");
});

test("sampled pending evaluation still cancels without a delayed native send", async () => {
  let release!: () => void;
  evaluateReply = () => new Promise<Response>(resolve => { release = () => resolve(Response.json(answer("high"))); });
  const controller = new AbortController();
  const pending = invoke(longLitePayload(), config(), controller.signal);
  await until(() => evaluated.length === 1); controller.abort(); release();
  const result = await pending;
  expect(sent).toHaveLength(0);
  expect(result.log.astraJev).toMatchObject({ status: "cancelled", reason: "cancelled" });
});

test("opaque prompt declaration keeps native forwarding and makes no evaluator request", async () => {
  const body = { ...payload(), prompt: { id: "prompt_unseen_fixture", version: "1", variables: { constraint: "keep this fixture constraint" } } };
  const before = JSON.stringify(body);
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const baseline = await invoke(body); expect(baseline.response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(sent[1]).toEqual(sent[0]);
  expect(sent[1].prompt).toEqual(body.prompt); expect(JSON.stringify(body)).toBe(before);
  expect(result.log.astraJev).toMatchObject({ status: "skipped", reason: "opaque_ancestry", finalEffort: "xhigh", evaluatorChoice: null });
});

test("opaque prompt on an ordinary parent remains opaque through alias descendants", async () => {
  const parent = { ...payload("gpt-6-astra"), prompt: { id: "ancestor_prompt_fixture", variables: { constraint: "unseen original constraint" } } };
  expect((await invoke(parent)).response.status).toBe(200); expect(evaluated).toHaveLength(0);
  for (let generation = 1; generation <= 2; generation++) {
    const result = await invoke({ ...payload(), previous_response_id: `resp_fixture_${generation}`, input: "Continue the prior goal." });
    expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(0);
    expect(sent[generation].reasoning.effort).toBe("xhigh");
    expect(result.log.astraJev).toMatchObject({ status: "skipped", reason: "opaque_ancestry", evaluatorChoice: null });
  }
  expect(sent[0].prompt).toEqual(parent.prompt);
});

test.each(["zero mass", "contradictory argmax"])("invalid Choice %s keeps the complete native baseline", async kind => {
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const baseline = await invoke(); expect(baseline.response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  evaluateReply = () => {
    const response = answer("low");
    response.answers.effort.probabilities = Object.fromEntries(ladder.map(effort => [effort, kind === "contradictory argmax" && effort === "high" ? 1 : 0]));
    return Response.json(response);
  };
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(1); expect(sent[1]).toEqual(sent[0]);
  expect(result.log.astraJev).toMatchObject({ status: "failed", reason: "invalid_response", evaluatorChoice: null, finalEffort: "xhigh" });
});

test("Responses Lite HTTP evaluates without top-level tools or instructions and preserves native bytes", async () => {
  const body = litePayload(); const before = JSON.stringify(body);
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const baseline = await invoke(body); expect(baseline.response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(1);
  expect(sent[1]).toEqual({ ...sent[0], reasoning: { ...sent[0].reasoning, effort: "low" } });
  // The existing store:false serializer strips item IDs in both controls, not the evaluator.
  expect(sent[1].input[0].tools).toEqual(body.input[0].tools);
  expect(sent[1].input[1].content).toEqual(body.input[1].content);
  expect(sent[1].tools).toBeUndefined(); expect(sent[1].instructions).toBeUndefined();
  expect(nativeHeaders[1].get("authorization")).toBe("Bearer fixture");
  expect(evaluated[0].state.history[0].type).toBe("tool_declarations_omitted");
  expect(evaluated[0].state.omissions.join(" ")).toContain("Tool declarations withheld");
  expect(JSON.stringify(evaluated[0])).not.toMatch(/private_(?:declaration|custom|default|metadata|client|program)_fixture/);
  expect(JSON.stringify(evaluated[0].state)).toContain("do not change any files");
  expect(JSON.stringify(body)).toBe(before);
  expect(result.log.astraJev).toMatchObject({ status: "applied", evaluatorChoice: "low", finalEffort: "low" });
});

test("Responses Lite WS uses the same evaluator and leaves declarations on the native wire", async () => {
  const body = litePayload();
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const client = wsClient();
  client.send(body);
  await until(() => client.frames.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(client.frames.at(-1)?.type).toBe("response.completed");
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ ...sent[0], reasoning: { ...sent[0].reasoning, effort: "low" } });
  expect(nativeHeaders[1].get("authorization")).toBe("Bearer fixture-native");
  expect(JSON.stringify(evaluated[0])).not.toContain("private_declaration_fixture");
});

test("Responses Lite ordinary parent and repeated declarations retain public continuity", async () => {
  const parent = await invoke(litePayload("gpt-6-astra"));
  expect(parent.response.status).toBe(200); expect(evaluated).toHaveLength(0);
  choices = ["high", "medium"];
  const resumedBody = litePayload(); resumedBody.previous_response_id = "resp_fixture_1";
  resumedBody.input.push({ type: "custom_tool_call", name: "apply_patch", call_id: "call_failure_fixture", input: "Fixture patch" },
    { type: "custom_tool_call_output", call_id: "call_failure_fixture", output: "Failed: fixture context not found." });
  const resumed = await invoke(resumedBody); expect(resumed.response.status).toBe(200);
  expect(evaluated).toHaveLength(1);
  expect(evaluated[0].state.history.filter((item: { type: string }) => item.type === "tool_declarations_omitted")).toHaveLength(2);
  expect(JSON.stringify(evaluated[0].state)).toContain("Failed: fixture context not found.");
  expect(JSON.stringify(evaluated[0].state)).not.toContain("private_declaration_fixture");
  expect(sent[1].input.filter((item: { type: string }) => item.type === "additional_tools")).toHaveLength(2);
  const third = await invoke({ ...litePayload(), previous_response_id: "resp_fixture_2" });
  expect(third.response.status).toBe(200); expect(evaluated).toHaveLength(2);
  expect(sent.map(body => body.reasoning.effort)).toEqual(["xhigh", "high", "medium"]);
});

test.each([
  { name: "native configuration updates", tail: [{ type: "configuration_update", reasoning: { effort: "high" } }, { type: "configuration_update", reasoning: { effort: "medium" } }], reason: "configuration_update" },
  { name: "unknown control", tail: [{ type: "future_private_control", private_data: "private_control_fixture" }], reason: "unsupported_item" },
  { name: "compaction", tail: [{ type: "compaction", encrypted_content: "opaque_compaction_fixture" }], reason: "compaction" },
])("Responses Lite $name still skips without changing native history", async ({ tail, reason }) => {
  const body = litePayload(); body.input.push(...tail);
  const before = JSON.stringify(body);
  delete process.env.OCX_ASTRA_JEV_ENABLED; expect((await invoke(body)).response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(sent[1]).toEqual(sent[0]);
  expect(result.log.astraJev).toMatchObject({ status: "skipped", reason, finalEffort: "xhigh" });
  expect(JSON.stringify(body)).toBe(before);
});

test.each(["role", "tools", "id", "extension"])("Responses Lite malformed %s envelope keeps native baseline", async kind => {
  const body = litePayload(); const item = body.input[0];
  if (kind === "role") delete item.role;
  if (kind === "tools") item.tools = null;
  if (kind === "id") item.id = 42;
  if (kind === "extension") item.private_metadata = "withheld_fixture";
  delete process.env.OCX_ASTRA_JEV_ENABLED; const baseline = await invoke(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "1"; const result = await invoke(body);
  expect(result.response.status).toBe(baseline.response.status); expect(evaluated).toHaveLength(0);
  expect(sent[1]).toEqual(sent[0]);
  expect(result.log.astraJev).toMatchObject({ status: "skipped", reason: "unsupported_item", finalEffort: "xhigh" });
});

test("Responses Lite declaration cannot hide an opaque prompt in ordinary ancestry", async () => {
  const parent = { ...litePayload("gpt-6-astra"), prompt: { id: "opaque_lite_prompt_fixture" } };
  expect((await invoke(parent)).response.status).toBe(200);
  const result = await invoke({ ...litePayload(), previous_response_id: "resp_fixture_1" });
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(0);
  expect(result.log.astraJev?.reason).toBe("opaque_ancestry"); expect(sent[1].reasoning.effort).toBe("xhigh");
});

test("Responses Lite warmup and native compact never evaluate", async () => {
  const client = wsClient(); client.send({ ...litePayload(), generate: false });
  await until(() => client.frames.some(frame => frame.type === "response.completed"));
  expect(evaluated).toHaveLength(0); expect(sent).toHaveLength(0);
  const response = await handleResponsesCompact(request(litePayload()), config(), { model: "", provider: "" });
  expect(response.status).toBe(200); await response.text(); expect(evaluated).toHaveLength(0);
});

test("Responses Lite WS supersession cancels pending evaluation without contaminating an ordinary successor", async () => {
  let release!: (response: Response) => void;
  evaluateReply = () => new Promise(resolve => { release = resolve; });
  const client = wsClient(); client.send(litePayload());
  await until(() => evaluated.length === 1);
  client.send(litePayload("gpt-6-astra")); await until(() => sent.length === 1);
  release(Response.json(answer("high"))); await Bun.sleep(20);
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(1); expect(sent[0].reasoning.effort).toBe("xhigh");
});

test("rounded tied Choice with low confidence reaches the pipeline as the named tier", async () => {
  evaluateReply = () => {
    const response = answer("high");
    response.answers.effort.confidence = 0;
    response.answers.effort.probabilities = Object.fromEntries(ladder.map(effort => [effort, effort === "low" ? 0.3333333 : effort === "high" ? 0.3333334 : effort === "medium" ? 0.3333333 : 0]));
    return Response.json(response);
  };
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(sent[0].reasoning.effort).toBe("high");
  expect(result.log.astraJev).toMatchObject({ status: "applied", evaluatorChoice: "high", finalEffort: "high" });
});

test("opted-in alias evaluates once and changes only native request effort", async () => {
  const original = payload(); const before = JSON.stringify(original);
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const baseline = await handleResponses(request(original), config(), { model: "", provider: "" });
  expect(baseline.status).toBe(200); await baseline.text();
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const response = await handleResponses(request(original), config(), { model: "", provider: "" });
  expect(response.status).toBe(200); await response.text();
  expect(evaluated).toHaveLength(1);
  expect(evaluated[0].model).toBe("jev-latest");
  expect(evaluated[0].questions.effort.type).toBe("choice");
  expect(Object.keys(evaluated[0].questions.effort.criteria)).toEqual(ladder);
  expect(sent[1]).toEqual({ ...sent[0], reasoning: { ...sent[0].reasoning, effort: "low" } });
  expect(JSON.stringify(original)).toBe(before);
});

test("successive invocations reconsider public goals and failed tool work", async () => {
  choices = ["low", "high"];
  const first = await invoke(); expect(first.response.status).toBe(200);
  const body = payload();
  body.input.push({ type: "function_call", namespace: "functions", name: "exec_command", call_id: "call_fixture", arguments: '{"cmd":"test fixture"}' },
    { type: "function_call_output", call_id: "call_fixture", output: "Process exited with code 1. Error: fixture check failed." },
    { role: "user", content: "Find the cause and fix it. Preserve the no-data-change constraint." });
  const second = await invoke(body); expect(second.response.status).toBe(200);
  expect(evaluated).toHaveLength(2);
  expect(JSON.stringify(evaluated[1].state)).toContain("Process exited with code 1");
  expect(JSON.stringify(evaluated[1].state)).toContain("no-data-change constraint");
  expect(sent.map(row => row.reasoning.effort)).toEqual(["low", "high"]);
  expect(first.log.astraJev?.requestedBaseline).toBe("xhigh");
  expect(second.log.astraJev).toMatchObject({ status: "applied", evaluatorChoice: "high", finalEffort: "high" });
});

test("WebSocket response.create reaches the same evaluator and preserves native credentials", async () => {
  process.env.TYPESAFE_API_KEY = "fixture-evaluator";
  const client = wsClient(); client.send(payload());
  await until(() => client.frames.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(client.frames.at(-1)?.type).toBe("response.completed");
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(1);
  expect(sent[0].reasoning.effort).toBe("low");
  expect(evaluatorHeaders[0].get("authorization")).toBe("Bearer fixture-evaluator");
  expect(nativeHeaders[0].get("authorization")).toBe("Bearer fixture-native");
  expect(evaluatorHeaders[0].get("chatgpt-account-id")).toBeNull();
});

test.each(["gpt-6-astra", "openai/gpt-6-astra", "openai/astra-jev", "gpt-5.6-sol"])("ordinary selection %s does not evaluate", async model => {
  const result = await invoke(payload(model)); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(result.log.astraJev).toBeUndefined();
  expect(sent[0].reasoning.effort).toBe("xhigh");
});

test("switching away and disabling the opt-in restore the ordinary native baseline", async () => {
  await invoke(); await invoke(payload("gpt-6-astra"));
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const disabled = await invoke();
  expect(evaluated).toHaveLength(1);
  expect(sent.map(row => row.reasoning.effort)).toEqual(["low", "xhigh", "xhigh"]);
  expect(disabled.log.astraJev).toMatchObject({ status: "skipped", reason: "disabled", finalEffort: "xhigh" });
});

test("native pins constrain the selected effort without changing shared configuration", async () => {
  choices = ["ultra"];
  const settings = config(); settings.providers.openai.pinnedReasoningEffort = "medium";
  const before = JSON.stringify(settings);
  const result = await invoke(payload(), settings);
  expect(result.response.status).toBe(200); expect(sent[0].reasoning.effort).toBe("medium");
  expect(result.log.astraJev).toMatchObject({ evaluatorChoice: "ultra", finalEffort: "medium", reason: "constrained" });
  expect(JSON.stringify(settings)).toBe(before);
});

test("ultra evaluator choice keeps the existing native inference boundary", async () => {
  choices = ["ultra"];
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(sent[0].reasoning.effort).toBe("max");
  expect(result.log.astraJev).toMatchObject({ evaluatorChoice: "ultra", finalEffort: "max", reason: "constrained" });
});

test.each([{ shape: "array", reasoning: ["xhigh"] }, { shape: "string", reasoning: "xhigh" }, { shape: "number", reasoning: 42 }])("unsupported $shape reasoning retains its native protocol error", async ({ reasoning }) => {
  const body = { ...payload(), reasoning };
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const baseline = await invoke(body); expect(baseline.response.status).toBe(400);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(400);
  expect(evaluated).toHaveLength(0); expect(sent).toHaveLength(0);
  expect(result.text).toBe(baseline.text);
});

test("existing native effort cap still constrains the evaluator's choice", async () => {
  choices = ["ultra"];
  const settings = config(); settings.effortCap = "medium";
  const log: RequestLogContext = { model: "", provider: "" };
  const req = request(payload()); req.headers.set("x-openai-subagent", "collab_spawn");
  const response = await handleResponses(req, settings, log);
  expect(response.status).toBe(200); await response.text();
  expect(sent[0].reasoning.effort).toBe("medium");
  expect(log.astraJev).toMatchObject({ evaluatorChoice: "ultra", finalEffort: "medium", reason: "constrained" });
});

test.each([
  ["configuration_update", { type: "configuration_update", model: "gpt-6-astra", reasoning: { effort: "ultra" } }],
  ["opaque_ancestry", { type: "item_reference", id: "opaque_fixture" }],
  ["compaction", { type: "compaction", encrypted_content: "opaque_fixture" }],
  ["unsupported_item", { type: "future_private_control", private_data: "do-not-evaluate" }],
] as const)("%s stays native with no evaluator and unchanged wire payload", async (reason, item) => {
  const body = payload(); body.input.push(item);
  delete process.env.OCX_ASTRA_JEV_ENABLED;
  const baseline = await invoke(body); expect(baseline.response.status).toBe(200);
  process.env.OCX_ASTRA_JEV_ENABLED = "1";
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(sent[1]).toEqual(sent[0]);
  expect(result.log.astraJev).toMatchObject({ status: "skipped", reason, finalEffort: "xhigh" });
});

test("private reasoning is never evaluator state while native opaque fields survive", async () => {
  const body = payload();
  body.input.push({ type: "reasoning", encrypted_content: "opaque_native_fixture", summary: [{ type: "summary_text", text: "Public summary of prior work." }] });
  body.tools.push({ type: "custom", name: "apply_patch", format: { type: "text" } });
  body.fixture_metadata = { unchanged: true };
  delete process.env.OCX_ASTRA_JEV_ENABLED; await invoke(body);
  process.env.OCX_ASTRA_JEV_ENABLED = "1"; await invoke(body);
  expect(sent[1]).toEqual({ ...sent[0], reasoning: { ...sent[0].reasoning, effort: "low" } });
  expect(JSON.stringify(evaluated[0].state)).not.toContain("opaque_native_fixture");
  expect(JSON.stringify(evaluated[0].state)).toContain("Public summary of prior work.");
  expect(evaluated[0].questions.effort.instructions).not.toEqual(body.instructions);
});

test("native compact and WS warmup bypass evaluation", async () => {
  const response = await handleResponsesCompact(request(payload()), config(), { model: "", provider: "" });
  expect(response.status).toBe(200); await response.text();
  const count = sent.length; const client = wsClient(); client.send({ ...payload(), generate: false });
  await until(() => client.frames.some(frame => frame.type === "response.completed"));
  expect(evaluated).toHaveLength(0); expect(sent).toHaveLength(count);
});

test("valid parent expands before evaluation; a missing parent retains its protocol error", async () => {
  rememberResponseState({ input: [{ role: "user", content: "The original goal forbids changing any files." }] },
    { id: "resp_parent", status: "completed", output: [{ type: "message", role: "assistant", content: "I will inspect first." }] });
  const resumed = await invoke({ ...payload(), previous_response_id: "resp_parent" });
  expect(resumed.response.status).toBe(200);
  expect(JSON.stringify(evaluated[0].state)).toContain("original goal forbids");
  const missing = await invoke({ ...payload(), previous_response_id: "resp_missing" });
  expect(missing.response.status).toBe(400); expect(missing.text).toContain("previous_response_not_found");
  expect(evaluated).toHaveLength(1); expect(sent).toHaveLength(1);
});

test("a parent's native configuration update forbids evaluation of the resumed turn", async () => {
  rememberResponseState({ input: [{ role: "user", content: "Keep the native configuration." }, { type: "configuration_update", reasoning: { effort: "high" } }] },
    { id: "resp_control_parent", status: "completed", output: [] });
  const result = await invoke({ ...payload(), previous_response_id: "resp_control_parent" });
  expect(result.response.status).toBe(200); expect(evaluated).toHaveLength(0);
  expect(result.log.astraJev?.reason).toBe("configuration_update");
  expect(sent[0].input.some((item: { type?: string }) => item.type === "configuration_update")).toBe(true);
});

test("a mismatched parent scope retains the release's native protocol error without evaluation", async () => {
  rememberResponseState({ input: [{ role: "user", content: "Other task context." }] },
    { id: "resp_foreign_scope", status: "completed", output: [] }, undefined, { clientThreadId: "other-fixture" });
  const result = await invoke({ ...payload(), previous_response_id: "resp_foreign_scope" });
  expect(result.response.status).toBe(400); expect(evaluated).toHaveLength(0);
  expect(result.text).toContain("previous_response_not_found"); expect(sent).toHaveLength(0);
});

test("local replay cannot erase an opaque ancestor's top-level control state", async () => {
  const first = await invoke({ ...payload(), conversation: "opaque_upstream_fixture" });
  expect(first.response.status).toBe(200); expect(evaluated).toHaveLength(0);
  const resumed = await invoke({ ...payload(), previous_response_id: "resp_fixture_1" });
  expect(resumed.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(resumed.log.astraJev?.reason).toBe("opaque_ancestry");
  expect(sent[1].reasoning.effort).toBe("xhigh");
});

test("loaded continuation state without in-process ancestry proof is not guessed complete", async () => {
  rememberResponseState({ input: [{ role: "user", content: "Original goal." }] },
    { id: "resp_loaded_parent", status: "completed", output: [] });
  await runPendingResponseStatePersistForTests(); clearResponseStateMemoryForTests();
  const resumed = await invoke({ ...payload(), previous_response_id: "resp_loaded_parent" });
  expect(resumed.response.status).toBe(200); expect(evaluated).toHaveLength(0);
  expect(resumed.log.astraJev?.reason).toBe("opaque_ancestry");
});

test("complete resident parent chains permit one new decision per logical invocation", async () => {
  choices = ["low", "medium", "high"];
  const firstBody = payload(); firstBody.reasoning.effort = "low";
  const secondBody = payload(); secondBody.reasoning.effort = "low";
  const thirdBody = payload(); thirdBody.reasoning.effort = "low";
  const first = await invoke(firstBody); expect(first.response.status).toBe(200);
  const second = await invoke({ ...secondBody, previous_response_id: "resp_fixture_1", input: "Continue the same goal." });
  const third = await invoke({ ...thirdBody, previous_response_id: "resp_fixture_2", input: "Verify the result carefully." });
  expect([second.response.status, third.response.status]).toEqual([200, 200]);
  expect(sent.map(row => row.reasoning.effort)).toEqual(["low", "medium", "high"]);
  expect(evaluated).toHaveLength(3);
});

test.each(["choice", "type", "model", "json", "network", "http", "oversized"])("evaluator %s failure keeps native baseline", async kind => {
  evaluateReply = () => {
    const value = answer();
    if (kind === "choice") value.answers.effort.choice = "unsupported";
    if (kind === "type") value.answers.effort.type = "score";
    if (kind === "model") value.model = "other-model";
    if (kind === "json") return new Response("not-json");
    if (kind === "network") throw new Error("secret upstream failure must not be logged");
    if (kind === "http") return new Response("secret failure body", { status: 503 });
    if (kind === "oversized") return new Response("x".repeat(17000));
    return Response.json(value);
  };
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(1); expect(sent[0].reasoning.effort).toBe("xhigh");
  expect(result.log.astraJev?.status).toBe("failed");
  expect(JSON.stringify(result.log.astraJev)).not.toMatch(/secret|not-json/);
});

test("missing evaluator credential is diagnosed without calling either alternative provider", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(sent).toHaveLength(1);
  expect(result.log.astraJev).toMatchObject({ reason: "credential_unavailable", finalEffort: "xhigh" });
});

test("evaluator deadline falls back once, discarding any late choice", async () => {
  let release!: (response: Response) => void;
  evaluateReply = () => new Promise<Response>(resolve => { release = resolve; });
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(result.log.astraJev).toMatchObject({ status: "failed", reason: "timeout", finalEffort: "xhigh" });
  expect(sent).toHaveLength(1); expect(sent[0].reasoning.effort).toBe("xhigh");
  release(Response.json(answer("ultra"))); await Bun.sleep(5);
  expect(sent).toHaveLength(1); expect(evaluated).toHaveLength(1);
}, 10000);

test("cancellation after evaluator body consumption still prevents dispatch", async () => {
  const controller = new AbortController();
  evaluateReply = () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(answer()))); },
    pull(c) { controller.abort(); c.close(); },
  }));
  const result = await invoke(payload(), config(), controller.signal);
  expect(result.response.status).toBe(499); expect(sent).toHaveLength(0);
});

test("closing the real WS handler cancels a pending evaluator with no delayed inference", async () => {
  let release!: (response: Response) => void;
  evaluateReply = () => new Promise<Response>(resolve => { release = resolve; });
  const client = wsClient(); client.send(payload());
  await until(() => evaluated.length === 1); client.ws.close();
  await until(() => client.ws.data.cancel === undefined);
  release(Response.json(answer())); await Bun.sleep(5);
  expect(sent).toHaveLength(0);
});

test("missing alias configuration cannot activate by selector spelling alone", async () => {
  const settings = config(); delete settings.providers.openai.modelAliases;
  const result = await invoke(payload(), settings);
  expect(evaluated).toHaveLength(0);
  expect(result.log.astraJev?.reason).toBe("unvalidated_alias");
});

test.each(["key", "gateway", "adapter", "model"])("final %s route cannot inherit evaluator activation", async kind => {
  const body = payload(); const settings = config(); const route = routeModel(settings, alias);
  if (kind === "key") route.provider.authMode = "key";
  if (kind === "gateway") route.provider.baseUrl = "https://gateway.example.test/v1";
  if (kind === "adapter") route.provider.adapter = "openai-chat";
  if (kind === "model") route.modelId = "gpt-5.6-sol";
  // The release captures the final adapter at route selection, not from later provider edits.
  route.staticPolicy = captureRouteStaticPolicy(route.providerName, route.modelId, route.provider,
    route.staticPolicy.effectiveAlias, "responses");
  if (kind === "adapter") route.staticPolicy = Object.freeze({ ...route.staticPolicy,
    model: Object.freeze({ ...route.staticPolicy.model, adapter: "openai-chat" as const }),
  });
  const log: RequestLogContext = { model: "", provider: "" };
  expect(await applyAstraJevEffort({ invocation: captureAstraJevInvocation(body, true, true)!,
    parsed: parseRequest(body), route, config: settings, logCtx: log, signal: new AbortController().signal })).toBe(true);
  expect(evaluated).toHaveLength(0); expect(log.astraJev?.reason).toBe("unvalidated_alias");
});

test("release adapter snapshot remains authoritative over a later provider adapter edit", async () => {
  const settings = config(); const body = payload(); const route = routeModel(settings, alias);
  expect(route.staticPolicy.model.adapter).toBe("openai-responses");
  route.provider.adapter = "openai-chat";
  const log: RequestLogContext = { model: "", provider: "" };
  expect(await applyAstraJevEffort({ invocation: captureAstraJevInvocation(body, true, true)!,
    parsed: parseRequest(body), route, config: settings, logCtx: log, signal: new AbortController().signal })).toBe(true);
  expect(evaluated).toHaveLength(1); expect(log.astraJev?.evaluatorChoice).toBe("low");
  expect(route.staticPolicy.model.adapter).toBe("openai-responses");
});

test("the existing normalization owner restores native baseline after a later route change", async () => {
  const body = payload(); const parsed = parseRequest(body); const settings = config();
  const route = routeModel(settings, alias); const req = request(payload()); const log: RequestLogContext = { model: "", provider: "" };
  const invocation = captureAstraJevInvocation(body, true, true)!;
  expect(await applyAstraJevEffort({ invocation, parsed, route, config: settings, logCtx: log, signal: req.signal })).toBe(true);
  await applyFinalRouteRequestNormalization({ parsed, route, config: settings, req, logCtx: log, inboundWire: "responses" });
  expect(parsed.options.reasoning).toBe("low");
  const other = routeModel(settings, "gpt-5.6-sol");
  await applyFinalRouteRequestNormalization({ parsed, route: other, config: settings, req, logCtx: log, inboundWire: "responses" });
  expect(parsed.options.reasoning).toBe("xhigh");
  expect((parsed._rawBody as { reasoning: { effort: string } }).reasoning.effort).toBe("xhigh");
  expect(log.astraJev).toMatchObject({ reason: "route_changed", finalEffort: "xhigh", status: "skipped" });
  expect(evaluated).toHaveLength(1);
});

test("disabling opt-in during evaluation discards the pending choice", async () => {
  let release!: (value: Response) => void;
  evaluateReply = () => new Promise<Response>(resolve => { release = resolve; });
  const pending = invoke(); await until(() => evaluated.length === 1);
  delete process.env.OCX_ASTRA_JEV_ENABLED; release(Response.json(answer("ultra")));
  const result = await pending; expect(result.response.status).toBe(200);
  expect(sent[0].reasoning.effort).toBe("xhigh"); expect(result.log.astraJev?.status).toBe("skipped");
});

test("an oversized user constraint is retained upstream, never shortened for evaluation", async () => {
  const body = payload(); const sentence = "Never change customer records. ";
  const constraint = sentence.repeat(Math.ceil(ASTRA_JEV_STATE_BYTES / Buffer.byteLength(sentence)) + 1);
  body.input.push({ role: "user", content: constraint });
  const result = await invoke(body); expect(result.response.status).toBe(200);
  expect(evaluated).toHaveLength(0); expect(result.log.astraJev?.reason).toBe("context_budget");
  expect(JSON.stringify(sent[0]).includes(constraint)).toBe(true);
});

test.each(["fetch", "body"])("caller cancellation during evaluator %s never dispatches native inference", async phase => {
  const controller = new AbortController(); let release!: (response: Response) => void; let bodyCancelled = false;
  evaluateReply = () => phase === "fetch" ? new Promise<Response>(resolve => { release = resolve; })
    : new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"model":')); }, cancel() { bodyCancelled = true; } }));
  const pending = invoke(payload(), config(), controller.signal);
  await until(() => evaluated.length === 1); await Bun.sleep(2); controller.abort();
  const result = await pending; expect(result.response.status).toBe(499);
  expect(result.log.astraJev?.status).toBe("cancelled");
  if (phase === "fetch") release(Response.json(answer()));
  else expect(bodyCancelled).toBe(true);
  await Bun.sleep(5); expect(sent).toHaveLength(0);
});

test("concurrent evaluations are isolated even when completed in reverse order", async () => {
  const releases: Array<(value: Response) => void> = [];
  evaluateReply = () => new Promise<Response>(resolve => { releases.push(resolve); });
  const one = invoke({ ...payload(), input: "Simple task one." });
  const two = invoke({ ...payload(), input: "Complex corrective task two." });
  await until(() => releases.length === 2);
  releases[1](Response.json(answer("high"))); await until(() => sent.length === 1);
  releases[0](Response.json(answer("low")));
  const results = await Promise.all([one, two]);
  expect(results.map(row => row.response.status)).toEqual([200, 200]);
  expect(sent.map(row => row.reasoning.effort)).toEqual(["high", "low"]);
  expect(results.map(row => row.log.astraJev?.evaluatorChoice)).toEqual(["low", "high"]);
});

test("native transient retries reuse the decision", async () => {
  nativeReply = () => sent.length === 1 ? new Response("retry fixture", { status: 503 }) : completed();
  const result = await invoke(); expect(result.response.status).toBe(200);
  expect(sent.length).toBeGreaterThan(1); expect(evaluated).toHaveLength(1);
  expect(sent.every(row => row.reasoning.effort === "low")).toBe(true);
});

test("live request-log diagnostic contains no context or credential fields", async () => {
  const result = await invoke();
  addFinalRequestLog("fixture_diagnostic", Date.now(), result.log, result.response.status);
  const row = getRequestLogEntries().find(entry => entry.requestId === "fixture_diagnostic")!;
  expect(row.astraJev).toMatchObject({ selectedAlias: alias, requestedBaseline: "xhigh", evaluatorChoice: "low", finalEffort: "low", status: "applied" });
  expect(Object.keys(row.astraJev!).sort()).toEqual(["evaluationMs", "evaluatorChoice", "finalEffort", "reason", "requestedBaseline", "selectedAlias", "status",
    "protectedBytes", "stateBytes", "requestBytes", "omittedItems", "omittedProtectedMessages",
    "omittedProtectedBytes", "repeatedMessages", "withheldMediaItems", "selectionMode", "budgetOwner",
    "providerInputTokens", "evaluatorModel", "preprocessingMs"].sort());
  expect(JSON.stringify(row.astraJev)).not.toMatch(/fixture|source instructions|Bearer|api_key/);
  const durable = readUsageEntries().find(entry => entry.requestId === "fixture_diagnostic");
  expect(durable).toBeDefined(); expect(durable).not.toHaveProperty("astraJev");
  const req = new Request("http://localhost/api/logs?model=gpt-6-astra&limit=20", { headers: { host: "localhost" } });
  const response = await handleManagementAPI(req, new URL(req.url), config());
  expect(response?.status).toBe(200);
  const readback = await response!.json() as { logs: Array<{ requestId: string; astraJev?: unknown }> };
  expect(readback.logs.find(entry => entry.requestId === "fixture_diagnostic")?.astraJev).toEqual(row.astraJev);
});

test("the logging boundary strips unknown diagnostic fields and records late cancellation", () => {
  const raw = { selectedAlias: alias as "openai/Astra-Jev", requestedBaseline: "xhigh" as const, evaluatorChoice: "low" as const,
    finalEffort: "low" as const, status: "applied" as const, reason: "selected" as const, evaluationMs: 2,
    prompt: "private_fixture", authorization: "Bearer private_fixture" };
  addRequestLog({ requestId: "fixture_safe_diagnostic", model: "gpt-6-astra", provider: "openai", timestamp: 1,
    status: 499, durationMs: 3, usageStatus: "unreported", astraJev: raw });
  const row = getRequestLogEntries().find(entry => entry.requestId === "fixture_safe_diagnostic")!;
  expect(row.astraJev).toMatchObject({ status: "cancelled", reason: "cancelled" });
  expect(JSON.stringify(row.astraJev)).not.toContain("private_fixture");
  raw.evaluationMs = 42; expect(row.astraJev?.evaluationMs).toBe(2);
});
