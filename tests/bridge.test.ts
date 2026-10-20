import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ALLOW_USAGE_CREDITS_ENV, usageCreditsAllowed } from "../src/billing.ts";
import { discoverClaudeModels, rewriteInitialRequest, runClaudeRequest } from "../src/claude-cli.ts";
import { normalizeError } from "../src/server.ts";

const command = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
await chmod(command, 0o755);
const common = {
  model: "sonnet", cwd: process.cwd(), systemPrompt: "system", manifest: [],
  extraBody: { tools: [] }, toolNames: new Set<string>(), timeoutMs: 5_000,
  env: { OPENCODE_CLAUDE_CODE_COMMAND: command },
};

test("discovers models and replays old turns without querying them", async () => {
  assert.deepEqual((await discoverClaudeModels(common.env)).map((entry) => entry.value), ["sonnet"]);
  const events: string[] = [];
  const result = await runClaudeRequest({ ...common, frames: [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "old" }] }, shouldQuery: false },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "new" }] } },
  ], onEvent: (event) => events.push(event.type) });
  assert.equal(result.message.stop_reason, "end_turn");
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(events.filter((event) => event === "message_start").length, 1);
});

test("usage credits are opt-in and usage-credit rejections stay billing errors", async () => {
  assert.equal(usageCreditsAllowed({}), false);
  assert.equal(usageCreditsAllowed({ [ALLOW_USAGE_CREDITS_ENV]: "false" }), false);
  const frames = [{ type: "user" as const, message: { role: "user" as const, content: [{ type: "text", text: "hi" }] } }];
  await assert.rejects(runClaudeRequest({ ...common, frames,
    env: { ...common.env, FAKE_OVERAGE: "1" },
  }), /Claude Code billing: .*usage credits/);
  const allowed = await runClaudeRequest({ ...common, frames,
    env: { ...common.env, FAKE_OVERAGE: "1", [ALLOW_USAGE_CREDITS_ENV]: "1" },
  });
  assert.equal(allowed.rateLimit?.isUsingOverage, true);
  assert.match(normalizeError(new Error("Third-party apps now draw from your extra usage")), /^Claude Code billing:/);
});

test("refuses conflicting auth and backend overrides", async () => {
  await assert.rejects(runClaudeRequest({ ...common, frames: [],
    env: { ...common.env, ANTHROPIC_API_KEY: "fixture" },
  }), /conflicting auth\/backend overrides: ANTHROPIC_API_KEY/);
});

test("cancellation stops a waiting Claude subprocess", async () => {
  const controller = new AbortController();
  const pending = runClaudeRequest({ ...common,
    env: { ...common.env, FAKE_HANG: "1" }, signal: controller.signal,
    frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "wait" }] } }],
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, { name: "AbortError" }); } finally { clearTimeout(timer); }
});

test("restores native reminders and injects system updates without losing effort", () => {
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: "user", content: [{ type: "text", text: "moving prefix" }, { type: "text", text: "hello" }] },
    { role: "system", content: [{ type: "text", text: "moving environment" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ] }));
  const rewritten = JSON.parse(rewriteInitialRequest(body,
    [{ type: "text", text: "stable prefix" }], [{ type: "text", text: "hello" }],
    [{ role: "system", content: [{ type: "text", text: "stable environment" }] }],
    [{ beforeAssistant: 0, content: [], fields: { output_config: { effort: "high" } } }],
  ).toString());
  assert.equal(rewritten.messages[0].content[0].text, "stable prefix");
  assert.equal(rewritten.messages[1].content[0].text, "stable environment");
  assert.deepEqual(rewritten.messages[2].output_config, { effort: "high" });
  assert.equal(rewritten.messages[3].role, "assistant");
});
