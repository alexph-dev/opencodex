import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { upstreamNativeEntry } from "../../src/codex/catalog";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import type { WsData } from "../../src/server/ws-bridge";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const native = "gpt-6-astra";
const alias = "openai/Astra-Jev";
const baseUrl = "https://chatgpt.com/backend-api/codex";
const realFetch = globalThis.fetch;
const realSocket = globalThis.WebSocket;
let releaseSpendHome = () => {};
const captured: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
const clients: Array<{ ws: ServerWebSocket<WsData>; handler: ReturnType<typeof createWebsocketHandler> }> = [];

function settings(): OcxConfig {
  return withStubbedProviderFetch({
    port: 0, defaultProvider: "openai", websockets: true,
    providers: { openai: {
      adapter: "openai-responses", baseUrl, authMode: "forward", codexAccountMode: "direct",
      upstreamWebsocket: false, modelAliases: { [native]: "Astra-Jev" },
    } },
  });
}
function body(model: string, effort = "xhigh") {
  return {
    model, stream: true, store: false,
    instructions: upstreamNativeEntry(native)!.base_instructions,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read the fixture, without changing it." }] }],
    tools: [
      { type: "namespace", name: "functions", tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] },
      { type: "custom", name: "apply_patch", format: { type: "text" } },
      { type: "web_search", search_context_size: "medium" },
    ],
    parallel_tool_calls: true, tool_choice: "auto", reasoning: { effort, summary: "none" },
    include: ["reasoning.encrypted_content"], text: { verbosity: "low" },
  };
}
function request(payload: Record<string, unknown>, compact = false) {
  return new Request(`http://localhost/v1/responses${compact ? "/compact" : ""}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" },
    body: JSON.stringify(payload),
  });
}
async function settled(condition: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (condition()) return; await Bun.sleep(1); }
  throw new Error("synthetic request did not finish");
}
beforeEach(() => {
  captured.length = 0;
  // Direct-handler fixtures hold the same journal ownership the release's server acquires.
  releaseSpendHome = acquireOwnedSpendHome();
  globalThis.WebSocket = class { constructor() { throw new Error("unexpected upstream WebSocket"); } } as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url !== `${baseUrl}/responses` && req.url !== `${baseUrl}/responses/compact`) throw new Error(`unexpected fixture URL: ${req.url}`);
    captured.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) });
    if (req.url.endsWith("/compact")) return Response.json({
      object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }],
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const response = { id: "resp_fixture", model: native, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
    return new Response([
      { type: "response.created", response: { ...response, status: "in_progress" } },
      { type: "response.completed", response },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
afterEach(async () => {
  try {
    for (const { ws, handler } of clients.splice(0)) {
      handler.close(ws, 1000, "fixture finished");
      await settled(() => ws.data.cancel === undefined && ws.data.nativeControl === undefined);
    }
  } finally {
    releaseSpendHome();
    globalThis.fetch = realFetch; globalThis.WebSocket = realSocket;
  }
});

test.each(["low", "xhigh"])("HTTP native alias keeps native instructions, tools and effort %s", async effort => {
  for (const model of [native, alias]) {
    const response = await handleResponses(request(body(model, effort)), settings(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
  }
  expect(captured).toHaveLength(2);
  expect(captured[1]!.body).toEqual(captured[0]!.body);
  expect(captured[1]!.body).toMatchObject({
    model: native, instructions: body(native).instructions, tools: body(native).tools,
    reasoning: { effort, summary: "none" }, parallel_tool_calls: true,
  });
  expect(captured[1]!.headers.get("authorization")).toBe("Bearer fixture");
  expect(captured[1]!.url).toBe(captured[0]!.url);
});

test("WS response.create uses the real shared request path and retains the HTTP payload", async () => {
  const response = await handleResponses(request(body(native)), settings(), { model: "", provider: "" });
  expect(response.status).toBe(200); await response.text();
  const handler = createWebsocketHandler({ config: settings(), deps: {} } as ServeOptionsContext);
  const sent: Array<Record<string, any>> = [];
  const ws = {
    readyState: 1, data: { headers: new Headers({ authorization: "Bearer fixture" }) } as WsData,
    send: (text: string) => { sent.push(JSON.parse(text)); return 1; },
    close: () => { handler.close(ws, 1000, "fixture finished"); },
  } as unknown as ServerWebSocket<WsData>;
  clients.push({ ws, handler });
  handler.message(ws, JSON.stringify({ type: "response.create", ...body(alias) }));
  await settled(() => sent.some(frame => frame.type === "response.completed" || frame.type === "error"));
  expect(sent.some(frame => frame.type === "error")).toBe(false);
  expect(sent.at(-1)?.type).toBe("response.completed");
  expect(captured).toHaveLength(2);
  expect(captured[1]!.body).toEqual(captured[0]!.body);
  expect(captured[1]!.body.model).toBe(native);
  expect(captured[1]!.headers.get("authorization")).toBe("Bearer fixture");
});

test("the real compact endpoint resolves the alias to the same native model", async () => {
  for (const model of [native, alias]) {
    const response = await handleResponsesCompact(request({ ...body(model), stream: false }, true), settings(), { model: "", provider: "" });
    expect(response.status).toBe(200); await response.text();
  }
  expect(captured).toHaveLength(2);
  expect(captured[1]!.url).toBe(`${baseUrl}/responses/compact`);
  expect(captured[1]!.body).toEqual(captured[0]!.body);
  expect(captured[1]!.body.model).toBe(native);
});
