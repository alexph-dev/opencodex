import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { InlineThinkTagParser } from "../../../src/adapters/inline-think-tags";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { AdapterEvent } from "../../../src/types";

// The installed overlay is an immutable input to this port, not newly implemented behavior.
const adapter = () => createOpenAIChatAdapter({
  adapter: "openai-chat", baseUrl: "https://fixture.example.test/v1", apiKey: "fixture",
});
function text(events: AdapterEvent[], type: "text_delta" | "reasoning_raw_delta"): string {
  return events.flatMap(event => event.type === type ? [event.text] : []).join("");
}

test.each(["think", "thinking", "reasoning"])("installed %s tag splitter retains chunked and interleaved behavior", tag => {
  const splitter = new InlineThinkTagParser(undefined, { interleaved: true });
  const input = `<${tag}>fixture first</${tag}>A<${tag}>fixture second</${tag}>B`;
  const events = [...input].flatMap(char => splitter.feed(char));
  events.push(...splitter.flush()); splitter.dispose();
  expect(text(events, "reasoning_raw_delta")).toBe("fixture firstfixture second");
  expect(text(events, "text_delta")).toBe("AB");
});

test("installed splitter leaves an ordinary answer mentioning tags untouched", () => {
  const splitter = new InlineThinkTagParser(undefined, { interleaved: true });
  const input = "Ordinary fixture answer: <think>quoted tag</think>.";
  const events = [...input].flatMap(char => splitter.feed(char));
  events.push(...splitter.flush()); splitter.dispose();
  expect(text(events, "text_delta")).toBe(input);
  expect(text(events, "reasoning_raw_delta")).toBe("");
});

test("installed openai-chat streaming path invokes inline recovery without a network send", async () => {
  const budget = createTranslatorBudget();
  try {
    const chunks = ["<th", "ink>fixture first</thi", "nk>A<reason", "ing>fixture second</reasoning>B"];
    const frames = chunks.map(content => ({ choices: [{ index: 0, delta: { content } }] }));
    const payload = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter().parseStream(new Response(payload), budget)) events.push(event);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    expect(text(events, "reasoning_raw_delta")).toBe("fixture firstfixture second");
    expect(text(events, "text_delta")).toBe("AB");
  } finally { budget.dispose(); }
});

test.each([
  { name: "inline", content: "<think>fixture reasoning</think>Fixture answer", reasoning: "fixture reasoning", answer: "Fixture answer" },
  { name: "ordinary", content: "Fixture answer mentions <think>tags</think>.", reasoning: "", answer: "Fixture answer mentions <think>tags</think>." },
])("installed openai-chat buffered $name behavior survives the port", async sample => {
  const budget = createTranslatorBudget();
  try {
    const response = Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: sample.content } }] });
    const events = await adapter().parseResponse!(response, budget);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(text(events, "reasoning_raw_delta")).toBe(sample.reasoning);
    expect(text(events, "text_delta")).toBe(sample.answer);
  } finally { budget.dispose(); }
});
