#!/usr/bin/env node
// A stream-json executable fixture, as in Pi's CLI/billing tests. No real auth or API.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(0);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const history = [];
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    console.log(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: frame.request_id, response: { models: [
        { value: "sonnet", displayName: "Sonnet", description: "Test model" },
      ] },
    } }));
    continue;
  }
  history.push(frame.message);
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", num_turns: 0 }));
    continue;
  }
  if (frame.type !== "user") continue;
  if (process.env.FAKE_HANG === "1") continue;
  if (process.env.FAKE_UPSTREAM === "1") {
    const settings = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"));
    const extra = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY);
    const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST", headers: { authorization: "Bearer fixture-only" },
      body: JSON.stringify({ ...extra, model: "sonnet", messages: history }),
    });
    await response.text();
  } else {
    const usage = { input_tokens: 3, output_tokens: 1 };
    const toolRound = process.env.FAKE_TOOL_ROUND === "1";
    const hasResult = frame.message.content.some((part) => part.type === "tool_result");
    const callTool = toolRound && !hasResult;
    const content = callTool
      ? { type: "tool_use", id: "t_read", name: "mcp__opencode__read", input: { path: `${process.cwd()}/probe.txt` } }
      : { type: "text", text: toolRound ? "claude-code-transport-ok" : "ok" };
    const reason = callTool ? "tool_use" : "end_turn";
    const events = [
      { type: "message_start", message: { id: "m", type: "message", model: "sonnet", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage } },
      { type: "content_block_start", index: 0, content_block: callTool ? { ...content, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: callTool
        ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
        : { type: "text_delta", text: content.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: reason }, usage },
      { type: "message_stop" },
    ];
    for (const event of events) console.log(JSON.stringify({ type: "stream_event", event }));
    console.log(JSON.stringify({ type: "assistant", message: {
      id: "m", role: "assistant", content: [content], stop_reason: reason, usage,
    } }));
  }
  console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: {
    status: "allowed", isUsingOverage: process.env.FAKE_OVERAGE === "1",
  } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 1 } }));
}
