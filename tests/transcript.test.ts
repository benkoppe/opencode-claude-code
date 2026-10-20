import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInputSchema, prepareRequest, TOOL_PREFIX } from "../src/transcript.ts";

test("preserves signed thinking and native tool inputs while renaming protocol names", () => {
  const signature = "signed-thinking";
  const plan = prepareRequest({
    model: "sonnet", system: [{ type: "text", text: "instructions" }], max_tokens: 123,
    tools: [{ name: "read", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "read a file" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "reasoning", signature },
        { type: "tool_use", id: "t", name: "read", input: { name: "do-not-rename" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "file contents" }] },
    ],
  });
  assert.equal(plan.frames[0]!.shouldQuery, false);
  assert.equal(plan.frames[2]!.shouldQuery, undefined);
  assert.deepEqual(plan.frames[1]!.message.content, [
    { type: "thinking", thinking: "reasoning", signature },
    { type: "tool_use", id: "t", name: `${TOOL_PREFIX}read`, input: { name: "do-not-rename" } },
  ]);
  assert.equal(plan.systemPrompt, "instructions");
  assert.equal(plan.extraBody.max_tokens, 123);
  assert.deepEqual(plan.extraBody.context_management, { edits: [] });
  assert.equal(plan.extraBody.thinking, undefined);
});

test("keeps chronological system updates and effort at their assistant boundaries", () => {
  const plan = prepareRequest({ model: "sonnet", messages: [
    { role: "user", content: "hello" },
    { role: "system", content: [{ type: "text", text: "new instructions" }], output_config: { effort: "high" } },
    { role: "assistant", content: "answer" },
    { role: "user", content: "next" },
    { role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "read" } }] },
  ] });
  assert.deepEqual(plan.nativeSystemInjections, [
    { beforeAssistant: 0, content: [{ type: "text", text: "new instructions" }], fields: { output_config: { effort: "high" } } },
    { beforeAssistant: null, content: [{ type: "tool_removal", tool: { type: "tool_reference", name: `${TOOL_PREFIX}read` } }], fields: {} },
  ]);
});

test("uses Pi's nullable schema simplification and tool name restrictions", () => {
  assert.deepEqual(normalizeInputSchema({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } } }), {
    type: "object", properties: { value: { type: "string" } },
  });
  assert.throws(() => prepareRequest({ model: "sonnet", messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "invalid.name", input_schema: {} }],
  }), /tool names/);
});

test("leaves cache markers to the CLI/relay without changing tool input data", () => {
  const cache_control = { type: "ephemeral" };
  const plan = prepareRequest({
    model: "sonnet", cache_control,
    tools: [{ name: "read", input_schema: { type: "object" }, cache_control }],
    messages: [
      { role: "user", content: [{ type: "text", text: "read", cache_control }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: { cache_control }, cache_control }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", cache_control,
        content: [{ type: "text", text: "contents", cache_control }] }] },
    ],
  });
  assert.equal(plan.extraBody.cache_control, undefined);
  assert.equal((plan.extraBody.tools as any[])[0].cache_control, undefined);
  const history = plan.frames.map((frame) => frame.message.content) as any[][];
  assert.equal(history[0][0].cache_control, undefined);
  assert.equal(history[1][0].cache_control, undefined);
  assert.deepEqual(history[1][0].input.cache_control, cache_control);
  assert.equal(history[2][0].content[0].cache_control, undefined);
});
