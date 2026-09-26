import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { AdapterEvent } from "../../../src/types";

// Unlike an explicitly empty inlineThinkTagModels list, an absent list keeps the
// installed default-on recovery for chat gateways that emit leading think tags.
test("openai-chat without a model list recovers streamed inline reasoning", async () => {
  const adapter = createOpenAIChatAdapter({
    adapter: "openai-chat", baseUrl: "https://fixture.example.test/v1", apiKey: "fixture",
  });
  const budget = createTranslatorBudget();
  try {
    const contents = ["<th", "ink>fixture first</thi", "nk>A<reason", "ing>fixture second</reasoning>B"];
    const payload = contents.map(content => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(payload), budget)) events.push(event);
    const joined = (type: "text_delta" | "reasoning_raw_delta") => events.flatMap(event => event.type === type ? [event.text] : []).join("");
    expect(events.at(-1)?.type).toBe("done");
    expect(joined("reasoning_raw_delta")).toBe("fixture firstfixture second");
    expect(joined("text_delta")).toBe("AB");
  } finally { budget.dispose(); }
});
