/** Fictional text only: matches the content-free native measurement, not a transcript. */
export const PROFILE_CONTENT_BYTES = [21513, 39184, 29134, 129] as const;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function content(bytes: number, index: number) {
  const parts = [{ type: "input_text", text: `Fixture constraint ${index}: preserve files. ` }];
  const remaining = bytes - size(parts);
  parts[0].text += "Public fixture. ".repeat(Math.ceil(remaining / 16)).slice(0, remaining);
  if (size(parts) !== bytes) throw new Error("synthetic content size mismatch");
  return parts;
}

export function astraJevSizedProfile(continuation = false) {
  const declaration = { type: "additional_tools", role: "developer", id: "fixture_declaration", tools: [
    { type: "function", name: "fixture_read", description: "private_declaration_sentinel " },
  ] };
  const remaining = 37596 - size(declaration);
  declaration.tools[0].description += "hidden fixture. ".repeat(Math.ceil(remaining / 16)).slice(0, remaining);
  if (size(declaration) !== 37596) throw new Error("synthetic declaration size mismatch");
  const input: Array<Record<string, unknown>> = [declaration,
    ...PROFILE_CONTENT_BYTES.map((bytes, index) => ({ type: "message",
      role: index < 2 ? "developer" : "user", content: content(bytes, index) })),
  ];
  if (continuation) input.push(
    { type: "custom_tool_call", name: "fixture_read", call_id: "call_fixture", input: "read fixture" },
    { type: "custom_tool_call_output", call_id: "call_fixture", output: "Fixture check failed; inspect before correction." },
  );
  const body = { model: "openai/Astra-Jev", stream: true, store: false, reasoning: { effort: "high", summary: "none" }, input,
    client_metadata: { fixture_padding: "private_padding_sentinel " } };
  // Unknown native metadata is NOT reconstructed: inert excluded padding matches only total size.
  const padding = 130181 - size({ ...body, input: input.slice(0, 5) });
  body.client_metadata.fixture_padding += "unused fixture. ".repeat(Math.ceil(padding / 16)).slice(0, padding);
  if (size({ ...body, input: input.slice(0, 5) }) !== 130181) throw new Error("synthetic body size mismatch");
  return body;
}
