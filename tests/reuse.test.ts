import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createClaudeRunner, type RunClaudeInput, type RunClaudeOutput } from "../src/claude-cli.ts";

const user = (text: string): RunClaudeInput["frames"][number] => ({
  type: "user", message: { role: "user", content: [{ type: "text", text }] },
});
const next = (input: RunClaudeInput, output: RunClaudeOutput): RunClaudeInput => ({
  ...input, frames: [
    ...input.frames.map((frame) => frame.type === "user" ? { ...frame, shouldQuery: false as const } : frame),
    { type: "assistant", message: { role: "assistant", content: output.message.content } }, user("next"),
  ],
});

async function fixture(options?: Parameters<typeof createClaudeRunner>[0]) {
  const root = await mkdtemp(join(tmpdir(), "claude-reuse-"));
  const runner = createClaudeRunner(options);
  const input: RunClaudeInput = {
    model: "sonnet", systemPrompt: "system", manifest: [], extraBody: { tools: [] },
    toolNames: new Set(), timeoutMs: 5_000, sessionId: "session/primary", frames: [user("first")],
    env: { OPENCODE_CLAUDE_CODE_COMMAND: fileURLToPath(new URL("./fake-claude.mjs", import.meta.url)),
      FAKE_PROCESS_LOG: join(root, "processes"), FAKE_FRAME_LOG: join(root, "frames") },
  };
  return { runner, input,
    pids: async () => (await readFile(join(root, "processes"), "utf8")).trim().split("\n").map(Number),
    frames: async () => (await readFile(join(root, "frames"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    close: async () => { await runner.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("retains exact continuations, sends only the new frame, and closes retained children", async () => {
  const f = await fixture();
  try {
    const first = await f.runner.run(f.input);
    const secondInput = next(f.input, first);
    const second = await f.runner.run(secondInput);
    assert.equal(second.message.content[0]?.type, "text");
    assert.equal((await f.pids()).length, 1);
    assert.equal((await f.frames()).length, 2);
    await f.runner.close();
    for (const pid of await f.pids()) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await assert.rejects(f.runner.run(secondInput), /runner is closed/);
  } finally { await f.close(); }
});

test("edited or compacted history, launch changes, and historical system updates force replay", async () => {
  for (const change of ["history", "system", "model", "metadata", "injection"] as const) {
    const f = await fixture();
    try {
      const first = await f.runner.run(f.input);
      const second = next(f.input, first);
      if (change === "history") second.frames[0] = { ...user("compacted summary"), shouldQuery: false };
      if (change === "system") second.systemPrompt += " changed";
      if (change === "model") second.model = "opus";
      if (change === "metadata") second.initialUserPrefix = [{ type: "text", text: "changed" }];
      if (change === "injection") second.nativeSystemInjections = [{ beforeAssistant: 0, content: [{ type: "text", text: "changed" }], fields: {} }];
      await f.runner.run(second);
      assert.equal((await f.pids()).length, 2, change);
      assert.equal((await f.frames()).length, 4, change);
    } finally { await f.close(); }
  }
});

test("system updates anchor to the historical assistant and permit subsequent continuation", async () => {
  const f = await fixture();
  try {
    f.input.nativeSystemInjections = [{ beforeAssistant: null, content: [], fields: { output_config: { effort: "high" } } }];
    const first = await f.runner.run(f.input);
    const second = next(f.input, first);
    second.nativeSystemInjections = [{ ...f.input.nativeSystemInjections[0]!, beforeAssistant: 0 }];
    await f.runner.run(second);
    assert.equal((await f.pids()).length, 1);
  } finally { await f.close(); }
});

test("warm relay rewrites chronological system updates and preserves the original native prefix", async () => {
  const bodies: any[] = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    const events = [
      { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const f = await fixture();
  try {
    let input: RunClaudeInput = { ...f.input, upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      env: { ...f.input.env, FAKE_UPSTREAM: "1" },
      initialUserPrefix: [{ type: "text", text: "stable native prefix" }],
      nativeSystemInjections: [{ beforeAssistant: null as number | null, content: [], fields: { output_config: { effort: "high" } } }],
    };
    for (let turn = 0; turn < 3; turn++) {
      const output = await f.runner.run(input);
      assert.equal(output.relay.upstreamRequests, 1);
      assert.equal(output.relay.blockedRequests, 0);
      assert.equal(bodies[turn].messages[0].content[0].text, "stable native prefix");
      assert.equal(bodies[turn].messages.filter((message: any) => message.role === "assistant").length, turn);
      assert.equal(bodies[turn].messages.filter((message: any) => message.role === "system").length, turn + 1);
      const continued = next(input, output);
      input = { ...input, frames: continued.frames,
        // Omitted metadata on a continuation must use the worker's captured copy.
        initialUserPrefix: undefined,
        nativeSystemInjections: [...input.nativeSystemInjections!.map((injection) => ({ ...injection, beforeAssistant: injection.beforeAssistant ?? turn })),
          { beforeAssistant: null, content: [], fields: { output_config: { effort: "high" } } }],
      };
    }
    assert.equal((await f.pids()).length, 1);
  } finally {
    await f.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("tool calls discard private inert results before replaying OpenCode results", async () => {
  const f = await fixture();
  try {
    f.input.env = { ...f.input.env, FAKE_TOOL_ROUND: "1" };
    f.input.toolNames = new Set(["read"]);
    const first = await f.runner.run(f.input);
    assert.equal(first.message.stop_reason, "tool_use");
    const second = next(f.input, first);
    second.frames[2] = { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t_read", content: "OpenCode's actual file content" },
    ] } };
    const output = await f.runner.run(second);
    assert.equal(output.message.stop_reason, "end_turn");
    assert.equal((await f.pids()).length, 2);
    assert.equal((await f.frames()).at(-1).frame.message.content[0].content, "OpenCode's actual file content");
  } finally { await f.close(); }
});

test("concurrent requests for one session never share a worker", async () => {
  const f = await fixture();
  try {
    await Promise.all([f.runner.run(f.input), f.runner.run(f.input)]);
    assert.equal((await f.pids()).length, 2);
    assert.equal(new Set((await f.frames()).map((entry) => entry.pid)).size, 2);
  } finally { await f.close(); }
});

test("evicts idle workers, expires retained workers, and replaces crashed workers", async () => {
  const f = await fixture({ maxWorkers: 1, maxAgeMs: 60_000 });
  try {
    const first = await f.runner.run(f.input);
    await f.runner.run({ ...f.input, sessionId: "other/primary" });
    await f.runner.run(next(f.input, first));
    assert.equal((await f.pids()).length, 3);
    const [pid] = (await f.pids()).slice(-1);
    process.kill(pid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.runner.run(f.input);
    assert.equal((await f.pids()).length, 4);
  } finally { await f.close(); }
  const expired = await fixture({ maxAgeMs: 1 });
  try {
    const first = await expired.runner.run(expired.input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expired.runner.run(next(expired.input, first));
    assert.equal((await expired.pids()).length, 2);
  } finally { await expired.close(); }
});

test("runner unload aborts pending work and billing failures cannot retain workers", async () => {
  const f = await fixture();
  try {
    f.input.env = { ...f.input.env, FAKE_OVERAGE: "1" };
    await assert.rejects(f.runner.run(f.input), /billing/);
    await assert.rejects(f.runner.run(f.input), /billing/);
    assert.equal((await f.pids()).length, 2);
    const pending = f.runner.run({ ...f.input, env: { ...f.input.env, FAKE_HANG: "1" } });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await f.runner.close();
    await rejected;
  } finally { await f.close(); }
});
