#!/usr/bin/env node
// Usage: OPENCODE_COMMAND=opencode node scripts/release-check.mjs /absolute/path/to/dist
// Calls real Claude and restarts only its isolated private OpenCode server.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const plugin = process.argv[2];
assert(plugin && isAbsolute(plugin), "Usage: node scripts/release-check.mjs /absolute/path/to/dist");
const command = process.env.OPENCODE_COMMAND ?? "opencode";
const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
assert(/v?2\./.test(version), `OpenCode V2 required, found ${version}`);
const modelID = process.env.RELEASE_CHECK_MODEL ?? "sonnet";
const model = { providerID: "claude-code", id: modelID };
const timeout = Number(process.env.RELEASE_CHECK_TIMEOUT_MS ?? 180000);
const temporary = process.env.TMPDIR ?? (process.platform === "linux" ? "/tmp/opencode" : tmpdir());
await mkdir(temporary, { recursive: true });
const root = await mkdtemp(join(temporary, "opencode-release-check-"));
const snapshot = join(root, "plugin");
await cp(plugin, snapshot, { recursive: true, dereference: true });
const hashes = {};
for (const file of await readdir(snapshot)) {
  if (/\.(js|mjs|json)$/.test(file)) hashes[file] = createHash("sha256").update(await readFile(join(snapshot, file))).digest("hex");
}
const report = { version, node: process.version, plugin, snapshot, hashes, model, root, tests: [] };
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("OPENCODE_") && !/^OPENCODE_CLAUDE_CODE_(COMMAND|CONFIG_DIR|NODE_COMMAND)$/.test(key)) delete env[key];
}
Object.assign(env, {
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CLAUDE_CODE_ALLOW_USAGE_CREDITS: "0",
});
const project = join(root, "project");
const autoProject = join(root, "auto-project");
const fact = `cobalt-otter-${randomUUID().slice(0, 8)}`;
const probe = `read-proof-${randomUUID().slice(0, 8)}`;
const prefix = Array.from({ length: 200 }, (_, i) => `Record ${String(i).padStart(3, "0")}: cobalt otters catalog quiet orchards, preserve amber notebooks, and verify silver lanterns before sunrise.`).join("\n");
const config = (auto) => ({
  plugins: [{ package: snapshot, options: { allowUsageCredits: false } }],
  model: `claude-code/${modelID}`, snapshots: false,
  agents: { title: { model: `claude-code/${modelID}` } },
  compaction: auto ? { auto: true, keep: { tokens: 0 }, buffer: 11000 } : { auto: false, keep: { tokens: 0 } },
  ...(auto ? { providers: { "claude-code": { models: { [modelID]: { limit: { context: 16000, output: 2048 } } } } } } : {}),
});
for (const [directory, auto] of [[project, false], [autoProject, true]]) {
  await mkdir(directory);
  await writeFile(join(directory, "opencode.json"), JSON.stringify(config(auto), null, 2));
  await writeFile(join(directory, "probe.txt"), `${probe}\n`);
}
let server;
let baseURL;
let authorization;
let generation = 0;
let sequence = 0;
let streamController;
let streamTask;
const events = [];
const secrets = new Set();
const redact = (text) => {
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/server password \S+/g, "server password [REDACTED]");
};
async function raw(path, body, method = body === undefined ? "GET" : "POST", save = true) {
  const response = await fetch(new URL(path, baseURL), {
    method, headers: { authorization, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  if (save) await writeFile(join(root, `${String(++sequence).padStart(4, "0")}-api.json`), redact(JSON.stringify({ path, method, status: response.status, response: text }, null, 2)));
  assert(response.ok, `${method} ${path}: HTTP ${response.status} ${redact(text).slice(0, 1200)}`);
  return text ? JSON.parse(text) : undefined;
}
async function api(path, body, method, save) {
  return (await raw(path, body, method, save))?.data;
}
async function start() {
  generation++;
  let logQueue = Promise.resolve();
  let startupError;
  server = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.on("error", (error) => { startupError = error; });
  baseURL = undefined;
  authorization = undefined;
  for (const stream of [server.stdout, server.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      const password = /server password (\S+)/.exec(line)?.[1];
      if (password) {
        const encoded = Buffer.from(`opencode:${password}`).toString("base64");
        secrets.add(password);
        secrets.add(encoded);
        authorization = `Basic ${encoded}`;
        secrets.add(authorization);
      }
      baseURL ??= /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
      logQueue = logQueue.then(() => appendFile(join(root, `server-${generation}.log`), `${redact(line)}\n`));
    });
  }
  const deadline = Date.now() + 60000;
  while (!baseURL || !authorization) {
    if (startupError) throw startupError;
    assert(server.exitCode === null, `Private server exited ${server.exitCode}`);
    assert(Date.now() < deadline, "Private server startup timed out");
    await delay(100);
  }
  await logQueue;
  report.info = await raw("/api/info");
  const schema = await raw("/openapi.json");
  report.schemaSha256 = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  for (const path of ["/api/session", "/api/session/{sessionID}/compact", "/api/session/{sessionID}/context", "/api/event"]) assert(schema.paths[path], `Missing V2 operation ${path}`);
  assert(schema.components.schemas["Session.Message.Compaction.Completed"].properties.reason.enum.includes("auto"), "Schema has automatic compaction reason");
  streamController = new AbortController();
  const response = await fetch(`${baseURL}/api/event`, { headers: { authorization }, signal: streamController.signal });
  assert(response.ok, "Event subscription authenticated");
  streamTask = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event = JSON.parse(data);
        if (typeof event === "string") event = JSON.parse(event);
        events.push(event);
        await appendFile(join(root, `events-${generation}.jsonl`), `${redact(JSON.stringify(event))}\n`);
      }
    }
  })().catch((error) => {
    if (!streamController.signal.aborted) report.eventStreamError = redact(String(error));
  });
}
async function stop() {
  streamController?.abort();
  await streamTask;
  if (!server || server.exitCode !== null) return;
  const child = server;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), delay(10000, undefined, { ref: false }).then(() => false)]);
  if (!graceful) {
    process.kill(-child.pid, "SIGKILL");
    await exited;
  }
  server = undefined;
}
async function waitFor(description, inspect) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await inspect();
    if (value) return value;
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function context(id, save = true) {
  return api(`/api/session/${id}/context`, undefined, undefined, save);
}
async function turn(id, text) {
  const before = new Set((await context(id, false)).map((message) => message.id));
  const admitted = await api(`/api/session/${id}/prompt`, { text });
  await waitFor(`turn ${admitted.id}`, async () => {
    const messages = await context(id, false);
    const idle = messages.findLast((message) => !before.has(message.id) && message.type === "idle");
    if (!idle) return false;
    assert.equal(idle.outcome, "succeeded", `Turn failed: ${JSON.stringify(messages.filter((message) => !before.has(message.id)))}`);
    return true;
  });
  const messages = (await context(id)).filter((message) => !before.has(message.id));
  const assistants = messages.filter((message) => message.type === "assistant");
  assert(assistants.length, "Completed turn contains an assistant response");
  assert(!assistants.some((message) => message.error), "No assistant errors");
  return { messages, assistants, text: assistants.flatMap((message) => message.content).filter((part) => part.type === "text").map((part) => part.text).join("\n") };
}
async function create(directory, title) {
  return (await api("/api/session", {
    title, model, location: { directory },
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
  })).id;
}
async function check(name, run) {
  try {
    const evidence = await run();
    report.tests.push({ name, status: "pass", evidence });
    console.log(`PASS ${name}`);
    return evidence ?? true;
  } catch (error) {
    report.tests.push({ name, status: "fail", error: redact(String(error)) });
    console.error(`FAIL ${name}: ${redact(String(error)).slice(0, 1200)}`);
    return false;
  }
}
function notVerified(name, reason) {
  report.tests.push({ name, status: "notverified", reason });
  console.error(`NOTVERIFIED ${name}: ${reason}`);
}
function assertRead(result) {
  const tools = result.assistants.flatMap((message) => message.content).filter((part) => part.type === "tool");
  assert(tools.some((part) => part.name === "read" && part.state.status === "completed" && JSON.stringify(part.state.content).includes(probe)), "A real completed read returned the probe");
  assert(tools.every((part) => part.name === "read"), "Only read tools executed");
  assert(result.text.includes(fact), "Reply recalls the distinctive user fact");
  assert(result.text.includes(probe), "Reply includes the read result");
}
process.once("SIGINT", () => { void stop().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(143)); });
console.log(`Artifacts ${root}`);
try {
  await start();
  const id = await create(project, "Release check manual");
  report.manualSession = id;
  const baseline = await check("baseline real request", async () => {
    const result = await turn(id, `Remember my release-check badge is ${fact}. Preserve this exact badge in any summary. Reply only READY.`);
    assert.equal(result.text.trim(), "READY");
  });
  if (baseline) {
    const compacted = await check("manual compaction completed summary", async () => {
      const admitted = await api(`/api/session/${id}/compact`, {});
      const completed = await waitFor("completed manual compaction", async () => {
        const messages = await context(id, false);
        const message = messages.find((item) => item.type === "compaction" && item.id === admitted.id);
        if (message?.status === "failed") throw new Error(JSON.stringify(message));
        return message?.status === "completed" && message;
      });
      assert.equal(completed.reason, "manual");
      assert(completed.summary.trim().length > 30, "Completed summary is nonempty");
      assert(completed.summary.includes(fact), "Summary preserves badge");
      assert(!(await context(id)).some((message) => message.type === "user" && message.text.includes(fact)), "Original fact-bearing user turn was replaced in active context");
      return { id: completed.id, reason: completed.reason, summaryCharacters: completed.summary.length };
    });
    if (compacted) {
      await check("follow-up recall and real read", async () => {
        const result = await turn(id, "Use the read tool on ./probe.txt. Reply with my release-check badge and the exact file contents, one short line. No other tools.");
        assertRead(result);
      });
      await check("private server restart and compacted session resume", async () => {
        await stop();
        await start();
        const messages = await context(id);
        assert(messages.some((item) => item.type === "compaction" && item.id === compacted.id && item.status === "completed"), "Same completed checkpoint survived restart");
        const result = await turn(id, "Read ./probe.txt again with the read tool. Reply with my release-check badge and exact file contents on one line. No other tools.");
        assertRead(result);
      });
    } else {
      for (const name of ["follow-up recall and real read", "private server restart and compacted session resume"]) notVerified(name, "Manual compaction failed");
    }
  } else {
    for (const name of ["manual compaction completed summary", "follow-up recall and real read", "private server restart and compacted session resume"]) notVerified(name, "Baseline request failed");
  }
  await check("multi-turn stable-prefix cache reads", async () => {
    const cacheID = await create(project, "Release check cache");
    report.cacheSession = cacheID;
    const usage = [];
    for (let index = 0; index < 3; index++) {
      const result = await turn(cacheID, index === 0
        ? `Keep this stable reference for the following turns. Its tag is ${fact}.\n${prefix}\nReply only ${fact}.`
        : "What is the stable reference tag? Reply only the tag. Do not use tools.");
      assert.equal(result.text.trim(), fact);
      assert(result.assistants.every((message) => message.content.every((part) => part.type !== "tool")), "Cache turns are plain-text continuations");
      usage.push(result.assistants.map((message) => message.tokens));
    }
    report.cacheUsage = usage;
    assert(usage.slice(1).flat().some((tokens) => tokens?.cache?.read > 0), "Server reports positive cache.read on a subsequent correct turn");
    return { prefixCharacters: prefix.length, usage };
  });
  await check("forced auto compaction and continued correctness", async () => {
    const autoID = await create(autoProject, "Release check auto");
    report.autoSession = autoID;
    const modelPath = `/api/model?location[directory]=${encodeURIComponent(autoProject)}`;
    const configured = await waitFor("plugin model registration", async () => (await api(modelPath, undefined, undefined, false)).find((entry) => entry.providerID === model.providerID && entry.id === model.id));
    await raw(modelPath);
    assert.equal(configured?.limit.context, 16000, "Effective model context override is active");
    report.autoModelLimit = configured.limit;
    const first = await turn(autoID, `Remember my release-check badge is ${fact}. Preserve it in summaries. The following expendable reference records may be discarded during compaction.\n${prefix.slice(0, 12000)}\nReply only READY.`);
    assert.equal(first.text.trim(), "READY");
    const result = await turn(autoID, "What is my release-check badge? Reply only the badge. Do not use tools.");
    assert.equal(result.text.trim(), fact);
    const messages = await context(autoID);
    const completed = messages.find((item) => item.type === "compaction" && item.status === "completed" && item.reason === "auto");
    assert(completed && completed.summary.trim(), "Completed compaction message has reason auto and a summary");
    await waitFor("compaction ended event with reason auto", async () => events.some((event) => event.type === "session.compaction.ended" && event.data.sessionID === autoID && event.data.reason === "auto"));
    const continued = await turn(autoID, "Use the read tool on ./probe.txt. Reply with my badge and exact file contents on one short line. No other tools.");
    assertRead(continued);
    return { id: completed.id, reason: completed.reason, summaryCharacters: completed.summary.length };
  });
} catch (error) {
  report.tests.push({ name: "private server/API setup", status: "fail", error: redact(String(error)) });
  console.error(redact(String(error)));
} finally {
  await stop();
  if (report.eventStreamError) report.tests.push({ name: "event stream", status: "fail", error: report.eventStreamError });
  for (const name of ["baseline real request", "manual compaction completed summary", "follow-up recall and real read", "private server restart and compacted session resume", "multi-turn stable-prefix cache reads", "forced auto compaction and continued correctness"]) {
    if (!report.tests.some((test) => test.name === name)) notVerified(name, "Earlier prerequisite failed");
  }
  report.performance = "notverified; this correctness run does not compare performance";
  await writeFile(join(root, "report.json"), redact(JSON.stringify(report, null, 2)));
  console.log(`Report ${join(root, "report.json")}`);
  process.exitCode = report.tests.some((test) => test.status !== "pass") ? 1 : 0;
}
