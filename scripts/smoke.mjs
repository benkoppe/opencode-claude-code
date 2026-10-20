// Explicit opt-in: uses your Claude login and a little subscription quota.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const plugin = resolve(process.argv[2] ?? "./dist");
await mkdir("/tmp/opencode", { recursive: true });
const root = await mkdtemp("/tmp/opencode/claude-code-smoke-");
const project = join(root, "project");
await mkdir(project);
await writeFile(join(project, "probe.txt"), "claude-code-transport-ok\n");
await writeFile(join(project, "opencode.json"), JSON.stringify({
  plugins: [plugin],
  model: "claude-code/sonnet",
  agents: { title: { model: "claude-code/sonnet" } },
  snapshots: false,
}));
console.error(`Isolated smoke-test files: ${root}`);
const child = spawn(process.env.OPENCODE_COMMAND ?? "opencode2", [
  "run", "--standalone", "--auto", "--format", "json", "--model", "claude-code/sonnet",
  "Use the read tool to read ./probe.txt, then reply with its exact contents. Do not change files or run any other tools.",
], {
  cwd: project,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  },
  stdio: ["inherit", "pipe", "inherit"],
});
let readCompleted = false;
let text = "";
let failed = false;
const output = createInterface({ input: child.stdout });
output.on("line", (line) => {
  console.log(line);
  try {
    const event = JSON.parse(line);
    if (event.type === "error") failed = true;
    if (event.type === "tool_use" && event.part?.tool === "read" && event.part.state?.status === "completed") readCompleted = true;
    if (event.type === "text") text += event.part?.text ?? "";
  } catch {
    failed = true;
  }
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", (code) => {
  const passed = code === 0 && !failed && readCompleted && text.includes("claude-code-transport-ok");
  if (!passed) console.error("Smoke test failed: expected a completed read and the probe contents in the reply.");
  process.exitCode = passed ? 0 : 1;
});
