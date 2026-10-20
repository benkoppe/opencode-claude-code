import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runClaudeRequest } from "../src/claude-cli.ts";
import { startServer } from "../src/server.ts";
import type { AnthropicStreamEvent } from "../src/native-types.ts";

test("bridges a native tool round and withholds tools on billing or inventory failure", async () => {
  const bodies: any[] = [];
  let toolName = "mcp__opencode__read";
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const hasResult = parsed.messages.at(-1).content.some((block: any) => block.type === "tool_result");
    const usage = { input_tokens: 5, output_tokens: 2 };
    const events: AnthropicStreamEvent[] = [
      { type: "message_start", message: { id: "native", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: hasResult
        ? { type: "text", text: "" }
        : { type: "tool_use", id: "t", name: toolName, input: {} } },
      { type: "content_block_delta", index: 1, delta: hasResult
        ? { type: "text_delta", text: "done" }
        : { type: "input_json_delta", partial_json: '{"path":"probe.txt"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: hasResult ? "end_turn" : "tool_use" }, usage },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let overage = false;
  const server = await startServer({
    cwd: process.cwd(),
    run: (input) => runClaudeRequest({ ...input, timeoutMs: 5_000,
      upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      env: { OPENCODE_CLAUDE_CODE_COMMAND: fileURLToPath(new URL("./fake-claude.mjs", import.meta.url)),
        FAKE_UPSTREAM: "1", FAKE_OVERAGE: overage ? "1" : "0" },
    }),
  });
  const initial = { role: "user", content: [{ type: "text", text: "read" }] };
  const tools = [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
  const send = async (messages: unknown[]) => {
    const response = await fetch(`${server.baseURL}/messages?beta=true`, {
      method: "POST", body: JSON.stringify({ model: "sonnet", tools, messages }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    const first = await send([initial]);
    assert.match(first, /"name":"read"/);
    assert.match(first, /"signature":"signature"/);
    assert.match(first, /"stop_reason":"tool_use"/);
    assert.equal(bodies[0].tools[0].name, "mcp__opencode__read");
    const second = await send([initial,
      { role: "assistant", content: [
        { type: "thinking", thinking: "reason", signature: "signature" },
        { type: "tool_use", id: "t", name: "read", input: { path: "probe.txt" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "file contents" }] },
    ]);
    assert.match(second, /"text":"done"/);
    assert.equal(bodies[1].messages[1].content[0].signature, "signature");
    assert.equal(bodies[1].messages[1].content[1].name, "mcp__opencode__read");
    overage = true;
    const failed = await send([initial]);
    assert.match(failed, /Claude Code billing:/);
    assert.doesNotMatch(failed, /"type":"tool_use"|event: message_stop/);
    assert.equal(bodies.length, 3);
    overage = false;
    toolName = "mcp__opencode__bash";
    const invalid = await send([initial]);
    assert.match(invalid, /tool outside OpenCode's current tool inventory/);
    assert.doesNotMatch(invalid, /"type":"tool_use"|event: message_stop|UND_ERR_SOCKET/);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
