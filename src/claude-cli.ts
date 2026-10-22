import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { TurnRelay } from "./turn-relay.ts";
import { usageCreditsAllowed, usageCreditsChargeError, type RateLimitInfo } from "./billing.ts";
import { envFlagEnabled } from "./env.ts";
import type { DiscoveredClaudeModel } from "./model-catalog.ts";
import type {
  AnthropicStreamEvent,
  NativeFrame,
  NativeMessage,
  NativeOutputEvent,
  NativeResult,
  NativeUsage,
} from "./native-types.ts";
import { TOOL_PREFIX, type NativeSystemInjection, type ToolManifestEntry } from "./transcript.ts";

export const INSTALL_HINT =
  "Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code` " +
   "or set OPENCODE_CLAUDE_CODE_COMMAND to the executable.";
export const LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login` and try again.";

export interface ClaudeStatus {
  available: boolean;
  loggedIn: boolean;
  /** True when Claude Code reports a Claude Pro/Max-style subscription login. */
  subscription: boolean;
  authMethod?: string;
  plan?: string;
  detail?: string;
  command?: string;
}

export interface RunClaudeInput {
  model: string;
  /** Working directory exposed to Claude and used for OpenCode tool paths. */
  cwd?: string;
  frames: NativeFrame[];
  systemPrompt: string;
  manifest: ToolManifestEntry[];
  extraBody: Record<string, unknown>;
  toolNames: Set<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  upstreamUrl?: string;
  /** Native blocks Claude Code injected ahead of the first canonical user message. */
  initialUserPrefix?: unknown[];
  /** Native system messages Claude Code injected immediately after that user message. */
  initialSystemMessages?: unknown[];
  /** System/tool deltas to restore at their historical assistant boundaries. */
  nativeSystemInjections?: NativeSystemInjection[];
  /** Beta features appended to Claude Code's own request header by the turn relay. */
  betas?: string[];
  onEvent?: (event: AnthropicStreamEvent) => void;
  sessionId?: string;
}

export interface RunClaudeOutput {
  message: NativeMessage;
  result: NativeResult;
  usage: NativeUsage;
  exitCode: number;
  relay: {
    upstreamRequests: number;
    blockedRequests: number;
    requestId?: string;
  };
  initialUserPrefix?: unknown[];
  initialSystemMessages?: unknown[];
  /** Latest plan-limit status Claude Code reported for this turn. */
  rateLimit?: RateLimitInfo;
}

function configuredCommand(env: Record<string, string | undefined>): string {
  return env.OPENCODE_CLAUDE_CODE_COMMAND || "claude";
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const command = configuredCommand(env);
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = resolve(command);
    return (await executable(candidate)) ? candidate : undefined;
  }

  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").flatMap((suffix) => [suffix, suffix.toLowerCase()])
      : [""];
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of extensions) {
      const candidate = join(directory, process.platform === "win32" && extname(command) ? command : command + suffix);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function withConfigDirectory(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) output[key] = value;
  if (output.OPENCODE_CLAUDE_CODE_CONFIG_DIR) output.CLAUDE_CONFIG_DIR = output.OPENCODE_CLAUDE_CODE_CONFIG_DIR;
  return output;
}

async function captureProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawnCommand(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-1_000_000)));
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const code = await childExit(child);
    signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function getClaudeStatus(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<ClaudeStatus> {
  const env = withConfigDirectory(envInput);
  const command = await resolveClaudeExecutable(env);
  if (!command) return { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT };
  try {
    const result = await captureProcess(command, ["auth", "status"], env, signal);
    const payload = result.stdout.trim().startsWith("{")
      ? (JSON.parse(result.stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown })
      : {};
    const loggedIn = payload.loggedIn === true;
    const plan = typeof payload.subscriptionType === "string" ? payload.subscriptionType : undefined;
    return {
      available: true,
      loggedIn,
      subscription: loggedIn && !!plan,
      command,
      authMethod: typeof payload.authMethod === "string" ? payload.authMethod : undefined,
      plan,
      detail: loggedIn ? undefined : LOGIN_HINT,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: true, loggedIn: false, subscription: false, command, detail: LOGIN_HINT };
  }
}

const READY_STATUS_TTL_MS = 60_000;
const readyStatusCache = new Map<string, { command: string; expires: number }>();

/**
 * Resolve a logged-in Claude Code executable. Successful checks are cached
 * briefly because a fresh worker is spawned after every tool call, and an
 * extra `claude auth status` process on each of those turns adds latency.
 */
async function readyClaudeCommand(
  envInput: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  const env = withConfigDirectory(envInput);
  const key = JSON.stringify([configuredCommand(env), env.PATH, env.HOME, env.CLAUDE_CONFIG_DIR]);
  const cached = readyStatusCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.command;

  const status = await getClaudeStatus(env, signal);
  if (!status.available || !status.command) throw new Error(INSTALL_HINT);
  if (!status.loggedIn) {
    readyStatusCache.delete(key);
    throw new Error(LOGIN_HINT);
  }
  readyStatusCache.set(key, { command: status.command, expires: Date.now() + READY_STATUS_TTL_MS });
  return status.command;
}

function isDiscoveredModel(value: unknown): value is DiscoveredClaudeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<DiscoveredClaudeModel>;
  return (
    typeof model.value === "string" &&
    typeof model.displayName === "string" &&
    typeof model.description === "string" &&
    (model.resolvedModel === undefined || typeof model.resolvedModel === "string")
  );
}

/** Ask the installed Claude Code process for the account's selectable model catalog. */
export async function discoverClaudeModels(
  envInput: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<DiscoveredClaudeModel[]> {
  signal?.throwIfAborted();
  const env = processEnvironment(envInput, {});
  const command = await resolveClaudeExecutable(env);
  if (!command) throw new Error(INSTALL_HINT);

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "default",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
  ];
  const child = spawnCommand(command, args, {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-65_536)));

  const abort = () => killProcessTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);

  const requestId = `opencode-models-${Date.now()}`;
  child.stdin?.write(
    `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
  );
  child.stdin?.end(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "model-catalog-probe" }] },
      shouldQuery: false,
    })}\n`,
  );

  let models: DiscoveredClaudeModel[] | undefined;
  try {
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "control_response") continue;
      const envelope = event.response as Record<string, unknown> | undefined;
      if (envelope?.request_id !== requestId || envelope.subtype !== "success") continue;
      const response = envelope.response as Record<string, unknown> | undefined;
      if (Array.isArray(response?.models)) models = response.models.filter(isDiscoveredModel);
    }
    const exitCode = await childExit(child);
    signal?.throwIfAborted();
    if (timedOut) throw new Error("Claude Code model discovery timed out");
    if (exitCode !== 0) throw new Error(`Claude Code model discovery failed${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`);
    if (!models?.length) throw new Error("Claude Code returned no selectable models");
    return models;
  } catch (error) {
    if (timedOut) throw new Error("Claude Code model discovery timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) killProcessTree(child);
  }
}

function spawnCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const comspec = options?.env?.COMSPEC || process.env.COMSPEC || "cmd.exe";
    const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
    return spawn(comspec, ["/d", "/s", "/c", [quote(command), ...args.map(quote)].join(" ")], options);
  }
  return spawn(command, args, options);
}

function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else reject(new Error(`Claude Code exited from signal ${signal ?? "unknown"}`));
    });
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // It exited between the checks.
    }
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined> {
    if (this.values.length) return this.values.shift();
    if (this.ended) {
      if (this.failure) throw this.failure;
      return undefined;
    }
    signal?.throwIfAborted();

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        fn();
      };
      const waiter = (item: IteratorResult<T>) =>
        finish(() => {
          if (item.done && this.failure) reject(this.failure);
          else resolve(item.done ? undefined : item.value);
        });
      const onAbort = () => finish(() => reject(signal?.reason ?? new Error("Claude Code request aborted")));
      const timer = setTimeout(() => finish(() => reject(new Error("Claude Code stream timed out"))), timeoutMs);
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function conflictingEnvironment(env: Record<string, string>): string[] {
  const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"].filter(
    (key) => !!env[key],
  );
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (envFlagEnabled(env[key])) conflicts.push(key);
  }
  return conflicts;
}

function processEnvironment(
  input: Record<string, string | undefined> | undefined,
  extraBody: Record<string, unknown>,
): Record<string, string> {
  const env = withConfigDirectory({ ...process.env, ...input });
  const conflicts = conflictingEnvironment(env);
  if (conflicts.length) {
    throw new Error(`Claude Code subscription provider refuses conflicting auth/backend overrides: ${conflicts.join(", ")}`);
  }
  delete env.CLAUDE_CODE_EXTRA_BODY;
  Object.assign(env, {
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  if (typeof extraBody.max_tokens === "number") env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(extraBody.max_tokens);
  return env;
}

async function writeFrame(child: ChildProcess, frame: NativeFrame): Promise<void> {
  if (!child.stdin?.writable) throw new Error("Claude Code stdin closed during history replay");
  if (!child.stdin.write(`${JSON.stringify(frame)}\n`)) {
    await new Promise<void>((resolve, reject) => {
      child.stdin!.once("drain", resolve);
      child.stdin!.once("error", reject);
    });
  }
}

function nativeErrorText(event: Extract<NativeOutputEvent, { type: "assistant" }>): string | undefined {
  const messageError = (event.message as Record<string, unknown>).error;
  if (!event.error && !messageError) return undefined;
  return event.message.content
    .filter((block): block is Extract<(typeof event.message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "cache_control") output[key] = withoutCacheControl(child);
  }
  return output;
}

interface NativeRequestMessage {
  role?: string;
  content?: unknown;
}

function requestMessages(body: Buffer | undefined): NativeRequestMessage[] | undefined {
  if (!body) return undefined;
  try {
    const payload = JSON.parse(body.toString("utf8")) as { messages?: unknown };
    return Array.isArray(payload.messages) ? (payload.messages as NativeRequestMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

function deriveInitialUserPrefix(body: Buffer | undefined, canonicalContent: unknown[]): unknown[] | undefined {
  if (canonicalContent.length === 0) return undefined;
  const actual = requestMessages(body)?.[0];
  if (actual?.role !== "user" || !Array.isArray(actual.content) || actual.content.length < canonicalContent.length) {
    return undefined;
  }
  const suffix = actual.content.slice(-canonicalContent.length).map(withoutCacheControl);
  if (JSON.stringify(suffix) !== JSON.stringify(canonicalContent.map(withoutCacheControl))) return undefined;
  return structuredClone(actual.content.slice(0, -canonicalContent.length));
}

function deriveInitialSystemMessages(body: Buffer | undefined): unknown[] | undefined {
  const messages = requestMessages(body);
  if (messages?.[0]?.role !== "user") return undefined;
  let end = 1;
  while (messages[end]?.role === "system") end += 1;
  const systems = messages.slice(1, end);

  // A replayed history from an older carrier has the date reminder at the
  // moving tail rather than in the initial environment reminder. Snapshot it
  // beside the environment so the next request has a stable prefix.
  let trailingStart = messages.length;
  while (trailingStart > end && messages[trailingStart - 1]?.role === "system") trailingStart -= 1;
  if (trailingStart < messages.length) systems.push(...messages.slice(trailingStart));
  return systems.length ? structuredClone(systems) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
        ? ((block as Record<string, unknown>).text as string)
        : "",
    )
    .join("");
}

function setCacheBreakpoint(message: NativeRequestMessage): void {
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content.at(-1);
  if (!last || typeof last !== "object") return;
  (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
}

function setReplayCacheBreakpoints(messages: NativeRequestMessage[]): void {
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length >= 3) {
    // Claude permits four cache breakpoints. Its two system-prompt markers
    // consume half of them, so once a prior queried user exists, move the
    // native environment marker to that exact previous query boundary. This
    // avoids relying on automatic lookback (notably unreliable with images).
    for (const message of messages) {
      if (message.role === "system") message.content = withoutCacheControl(message.content);
    }
    setCacheBreakpoint(messages[userIndexes.at(-2)!]!);
  }
  const final = messages.at(-1);
  if (final) setCacheBreakpoint(final);
}

function removeRepeatedUserReminders(messages: NativeRequestMessage[], prefix: unknown[] | undefined): void {
  const reminder = contentText(prefix).trimEnd();
  if (!reminder || !prefix) return;
  const normalizedPrefix = JSON.stringify(prefix.map(withoutCacheControl));

  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const leading = message.content.slice(0, prefix.length).map(withoutCacheControl);
    if (JSON.stringify(leading) === normalizedPrefix) message.content.splice(0, prefix.length);

    const toolResult = message.content.findLast(
      (block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result",
    ) as Record<string, unknown> | undefined;
    if (!toolResult) continue;

    const suffix = `\n${reminder}`;
    if (typeof toolResult.content === "string" && toolResult.content.endsWith(suffix)) {
      toolResult.content = toolResult.content.slice(0, -suffix.length);
    } else if (Array.isArray(toolResult.content)) {
      const final = toolResult.content.at(-1) as Record<string, unknown> | undefined;
      if (final?.type === "text" && typeof final.text === "string") {
        if (final.text === reminder) toolResult.content.pop();
        else if (final.text.endsWith(suffix)) final.text = final.text.slice(0, -suffix.length);
      }
    }
  }
}

function injectNativeSystemMessages(
  messages: NativeRequestMessage[],
  injections: NativeSystemInjection[],
): NativeRequestMessage[] {
  const byAssistant = new Map<number, NativeRequestMessage[]>();
  const trailing: NativeRequestMessage[] = [];
  for (const injection of injections) {
    const message = { ...injection.fields, role: "system", content: structuredClone(injection.content) };
    if (injection.beforeAssistant === null) trailing.push(message);
    else {
      const pending = byAssistant.get(injection.beforeAssistant) ?? [];
      pending.push(message);
      byAssistant.set(injection.beforeAssistant, pending);
    }
  }

  const output: NativeRequestMessage[] = [];
  let assistantOrdinal = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      output.push(...(byAssistant.get(assistantOrdinal) ?? []));
      byAssistant.delete(assistantOrdinal);
      assistantOrdinal += 1;
    }
    output.push(message);
  }
  if (byAssistant.size > 0) throw new Error("Claude Code request lost an assistant boundary needed by system history");
  output.push(...trailing);
  return output;
}

function normalizeLeadingSystemCache(system: unknown): void {
  if (!Array.isArray(system)) return;
  for (const block of system) {
    if (block && typeof block === "object") delete (block as Record<string, unknown>).cache_control;
  }
  const last = system.at(-1);
  if (last && typeof last === "object") {
    (last as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
  }
}

export function rewriteInitialRequest(
  body: Buffer,
  prefix: unknown[] | undefined,
  canonicalContent: unknown[],
  initialSystemMessages: unknown[] | undefined,
  nativeSystemInjections?: NativeSystemInjection[],
): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as {
    messages?: NativeRequestMessage[];
    system?: unknown;
  };
  let messages = payload.messages;
  const first = messages?.[0];
  if (first?.role !== "user" || !Array.isArray(first.content)) {
    throw new Error("Claude Code request is missing its initial user message");
  }
  if (prefix) first.content = [...structuredClone(prefix), ...structuredClone(canonicalContent)];

  if (initialSystemMessages?.length && messages) {
    let systemEnd = 1;
    while (messages[systemEnd]?.role === "system") systemEnd += 1;
    messages.splice(1, systemEnd - 1, ...(structuredClone(initialSystemMessages) as NativeRequestMessage[]));

    const initialText = initialSystemMessages
      .map((message) => contentText((message as NativeRequestMessage).content))
      .join("\n");
    while (messages.at(-1)?.role === "system") {
      const trailingText = contentText(messages.at(-1)?.content);
      if (!trailingText || !initialText.includes(trailingText)) break;
      messages.pop();
    }
    removeRepeatedUserReminders(messages, prefix);
  }

  if (nativeSystemInjections) {
    messages = injectNativeSystemMessages(messages!, nativeSystemInjections);
    payload.messages = messages;
    normalizeLeadingSystemCache(payload.system);
  }
  if (initialSystemMessages?.length || nativeSystemInjections) setReplayCacheBreakpoints(messages!);

  return Buffer.from(JSON.stringify(payload));
}

interface ClaudeLaunchPlan {
  env: Record<string, string>;
  timeoutMs: number;
  fingerprint: string;
}

function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)));
  });
  return createHash("sha256").update(canonical ?? "null").digest("hex");
}

function historyHash(frames: NativeFrame[], injections: NativeSystemInjection[] = []): string {
  return digest({ frames: frames.map(({ type, message }) => ({ type, message })), injections });
}

function launchPlan(input: RunClaudeInput): ClaudeLaunchPlan {
  const env = processEnvironment(input.env, input.extraBody);
  const timeoutMs = input.timeoutMs ?? 180_000;
  return {
    env,
    timeoutMs,
    fingerprint: digest({
      command: configuredCommand(env), cwd: resolve(input.cwd ?? process.cwd()), env,
      extraBody: input.extraBody, manifest: input.manifest, model: input.model,
      systemPrompt: input.systemPrompt, timeoutMs,
      upstreamUrl: input.upstreamUrl ?? "https://api.anthropic.com",
      betas: input.betas ?? [], toolNames: [...input.toolNames].sort(),
    }),
  };
}

class ClaudeProcess {
  readonly createdAt = Date.now();
  lastUsed = this.createdAt;
  private tipHash?: string;
  private replay?: { initialUserPrefix?: unknown[]; initialSystemMessages?: unknown[] };
  private closing?: Promise<void>;
  private closed = false;
  private stderr = "";

  private constructor(
    readonly fingerprint: string,
    private readonly root: string,
    private readonly child: ChildProcess,
    private readonly relay: TurnRelay,
    private readonly queue: AsyncQueue<NativeOutputEvent>,
    private readonly readTask: Promise<void>,
    private readonly exitOutcome: Promise<{ code?: number; error?: Error }>,
    private readonly timeoutMs: number,
  ) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-65_536)));
  }

  static async create(input: RunClaudeInput, plan: ClaudeLaunchPlan): Promise<ClaudeProcess> {
    input.signal?.throwIfAborted();
    const command = await readyClaudeCommand({ ...process.env, ...input.env }, input.signal);

    const root = await mkdtemp(join(tmpdir(), "opencode-claude-code-"));
    const toolsPath = join(root, "tools.json");
    const settingsPath = join(root, "settings.json");
    const systemPath = join(root, "system.md");
    const inertMcpPath = fileURLToPath(new URL("./inert-mcp.mjs", import.meta.url));
    let child: ChildProcess | undefined;
    let relay: TurnRelay | undefined;

    try {
      await Promise.all([
        writeFile(toolsPath, JSON.stringify(input.manifest), "utf8"),
        writeFile(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(input.extraBody) } }), "utf8"),
        writeFile(systemPath, input.systemPrompt, "utf8"),
      ]);

      relay = new TurnRelay(input.upstreamUrl ?? "https://api.anthropic.com", plan.timeoutMs);
      const env: Record<string, string> = { ...plan.env, ANTHROPIC_BASE_URL: await relay.start() };
      const mcp = {
        mcpServers: {
          opencode: { command: env.OPENCODE_CLAUDE_CODE_NODE_COMMAND || "node", args: [inertMcpPath, toolsPath] },
        },
      };
      const args = [
        "-p",
        "--model",
        input.model,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--system-prompt-file",
        systemPath,
        "--settings",
        settingsPath,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--mcp-config",
        JSON.stringify(mcp),
      ];

      child = spawnCommand(command, args, {
        // Claude Code tells the model its process cwd. Keep transport files
        // private while exposing OpenCode's real working directory to the model.
        cwd: input.cwd ?? process.cwd(),
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const queue = new AsyncQueue<NativeOutputEvent>();
      const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      const readTask = (async () => {
        try {
          for await (const line of reader) {
            if (!line.trim()) continue;
            try {
              queue.push(JSON.parse(line) as NativeOutputEvent);
            } catch (error) {
              throw new Error(`Invalid Claude Code stream-json output: ${line.slice(0, 300)}`, { cause: error });
            }
          }
          queue.end();
        } catch (error) {
          queue.end(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      const exitOutcome = childExit(child).then(
        (code) => ({ code }),
        (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
      );
      return new ClaudeProcess(plan.fingerprint, root, child, relay, queue, readTask, exitOutcome, plan.timeoutMs);
    } catch (error) {
      relay?.abort();
      if (child && child.exitCode === null) killProcessTree(child);
      await relay?.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !!this.child.stdin?.writable;
  }

  canContinue(input: RunClaudeInput): boolean {
    const last = input.frames.at(-1);
    if (!this.tipHash || last?.type !== "user" || last.shouldQuery === false) return false;
    if (input.initialUserPrefix !== undefined && digest(input.initialUserPrefix) !== digest(this.replay?.initialUserPrefix)) return false;
    if (input.initialSystemMessages !== undefined && digest(input.initialSystemMessages) !== digest(this.replay?.initialSystemMessages)) return false;
    return this.tipHash === historyHash(input.frames.slice(0, -1),
      input.nativeSystemInjections?.filter((injection) => injection.beforeAssistant !== null));
  }

  commit(input: RunClaudeInput, output: RunClaudeOutput): boolean {
    // Claude's private history contains the inert MCP result, not OpenCode's result.
    if (output.message.content.some((block) => block.type === "tool_use")) return false;
    const ordinal = input.frames.filter((frame) => frame.type === "assistant").length;
    const injections = input.nativeSystemInjections?.map((injection) => ({
      ...injection, beforeAssistant: injection.beforeAssistant ?? ordinal,
    }));
    this.tipHash = historyHash([...input.frames, {
      type: "assistant", message: { role: "assistant", content: output.message.content },
    }], injections);
    this.replay = structuredClone({
      initialUserPrefix: output.initialUserPrefix, initialSystemMessages: output.initialSystemMessages,
    });
    this.lastUsed = Date.now();
    return true;
  }

  async run(input: RunClaudeInput, continuation = false): Promise<RunClaudeOutput> {
    if (continuation) input = { ...this.replay, ...input,
      initialUserPrefix: input.initialUserPrefix ?? this.replay?.initialUserPrefix,
      initialSystemMessages: input.initialSystemMessages ?? this.replay?.initialSystemMessages,
    };
    if (!this.isAlive()) throw new Error("Claude Code process is no longer available");
    input.signal?.throwIfAborted();

    let sawMessageStop = false;
    const deliver = (event: AnthropicStreamEvent) => {
      if (event.type === "message_stop") sawMessageStop = true;
      input.onEvent?.(event);
    };
    const canonicalInitialUser = input.frames.find((frame) => frame.type === "user")?.message.content ?? [];
    this.relay.beginTurn(
      deliver,
      input.initialUserPrefix || input.initialSystemMessages || input.nativeSystemInjections
        ? (body) =>
            rewriteInitialRequest(
              body,
              input.initialUserPrefix,
              canonicalInitialUser,
              input.initialSystemMessages,
              input.nativeSystemInjections,
            )
        : undefined,
      input.betas,
    );

    const abort = () => {
      this.relay.abort();
      this.closeNow();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const assistants: NativeMessage[] = [];
    let result: NativeResult | undefined;
    let nativeError: string | undefined;
    let rateLimit: RateLimitInfo | undefined;

    try {
      for (const frame of continuation ? input.frames.slice(-1) : input.frames) {
        await writeFrame(this.child, frame);
        if (frame.shouldQuery === false) {
          for (;;) {
            const event = await this.queue.next(input.signal, this.timeoutMs);
            if (!event) throw await this.exitError("Claude Code exited before acknowledging history replay");
            if (event.type === "result") {
              if (event.num_turns !== 0 || event.is_error) {
                throw new Error("Claude Code rejected zero-turn history replay");
              }
              break;
            }
          }
        }
      }

      for (;;) {
        const event = await this.queue.next(input.signal, this.timeoutMs);
        if (!event) throw await this.exitError("Claude Code exited before completing its response");
        if (event.type === "assistant") {
          const error = nativeErrorText(event);
          if (error !== undefined) nativeError = error;
          else assistants.push(event.message);
        } else if (event.type === "result") {
          result = event;
          break;
        } else if (event.type === "rate_limit_event") {
          if (event.rate_limit_info && typeof event.rate_limit_info === "object") rateLimit = event.rate_limit_info;
        } else if (event.type === "stream_event" && !this.relay.used) {
          deliver(event.event);
        }
      }
      await this.relay.settled();
      input.signal?.throwIfAborted();

      let message: NativeMessage | undefined;
      if (this.relay.used) {
        if (this.relay.status !== 200 || !this.relay.capture.complete || !this.relay.capture.message) {
          let detail = `status ${this.relay.status ?? "unknown"}, capture ${this.relay.capture.complete ? "complete" : "incomplete"}`;
          if (this.relay.failure) detail += `, relay failure ${this.relay.failure}`;
          if (this.relay.denied) detail += `, native retries denied ${this.relay.denied}`;
          const upstreamError = this.relay.errorText();
          if (upstreamError) detail += `, upstream said: ${upstreamError.slice(0, 500)}`;
          throw new Error(`Incomplete Claude Code upstream response (${detail})`);
        }
        message = this.relay.capture.message;
        sawMessageStop = true;
      } else {
        message = assistants.at(-1);
      }

      const nativeFailureHandled = this.relay.denied > 0 || message?.stop_reason === "refusal";
      if (nativeError && !nativeFailureHandled) throw new Error(`Claude Code API error: ${nativeError}`);
      if (!message || !sawMessageStop || !result) {
        throw new Error(
          `Incomplete Claude Code response: assistant, message_stop and one result required${result ? ` (result ${result.subtype}, turns ${result.num_turns}${result.errors ? `: ${JSON.stringify(result.errors)}` : ""})` : ""}${this.stderr ? ` (${this.stderr.trim().slice(-500)})` : ""}`,
        );
      }

      const hasTools = message.content.some((block) => block.type === "tool_use");
      const maxTurnsBoundary = hasTools && result.subtype === "error_max_turns";
      if (!maxTurnsBoundary && !nativeFailureHandled && (result.is_error || result.subtype !== "success")) {
        throw new Error(`Claude Code request failed: ${result.subtype ?? "unknown result"}`);
      }

      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        if (!block.name.startsWith(TOOL_PREFIX) || !input.toolNames.has(block.name.slice(TOOL_PREFIX.length))) {
          throw new Error("Claude Code returned a tool outside OpenCode's current tool inventory");
        }
      }

      const usage = message.usage ?? result.usage;
      if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
        throw new Error("Claude Code response did not include complete token usage");
      }

      // The response is already charged at this point, but stopping here keeps
      // OpenCode's agent loop from issuing more requests against usage credits.
      if (rateLimit?.isUsingOverage === true && !usageCreditsAllowed({ ...process.env, ...input.env })) {
        throw usageCreditsChargeError(rateLimit);
      }

      return {
        message,
        result,
        usage,
        exitCode: this.child.exitCode ?? 0,
        relay: {
          upstreamRequests: Number(this.relay.used),
          blockedRequests: this.relay.denied,
          requestId: this.relay.requestId,
        },
        initialUserPrefix:
          input.initialUserPrefix ?? deriveInitialUserPrefix(this.relay.originalRequestBody, canonicalInitialUser),
        initialSystemMessages:
          input.initialSystemMessages ?? deriveInitialSystemMessages(this.relay.originalRequestBody),
        rateLimit,
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.relay.finishTurn();
    }
  }

  close(): Promise<void> {
    this.closeNow();
    return this.closing ??= (async () => {
      await Promise.allSettled([this.readTask, this.exitOutcome, this.relay.close()]);
      await rm(this.root, { recursive: true, force: true });
    })();
  }

  private closeNow(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.abort();
    if (this.child.exitCode === null) killProcessTree(this.child);
  }

  private async exitError(fallback: string): Promise<Error> {
    const outcome = await this.exitOutcome;
    if (outcome.error) return outcome.error;
    const detail = this.stderr.trim().slice(-500);
    return new Error(`${fallback} (exit ${outcome.code ?? "unknown"}${detail ? `: ${detail}` : ""})`);
  }
}

type ProcessSlot =
  | { state: "starting" }
  | { state: "busy"; worker: ClaudeProcess }
  | { state: "idle"; worker: ClaudeProcess; timer: NodeJS.Timeout };

export function createClaudeRunner({ maxWorkers = 2, maxAgeMs = 300_000 } = {}) {
  const slots = new Map<string, ProcessSlot>();
  const workers = new Set<ClaudeProcess>();
  const active = new Set<Promise<RunClaudeOutput>>();
  const closing = new Set<Promise<void>>();
  const shutdown = new AbortController();
  let closeTask: Promise<void> | undefined;

  const retire = (worker: ClaudeProcess) => {
    workers.delete(worker);
    const task = worker.close();
    closing.add(task);
    task.then(() => closing.delete(task), () => closing.delete(task));
    return task;
  };
  const remove = (key: string, slot: ProcessSlot) => {
    if (slots.get(key) !== slot) return;
    slots.delete(key);
    if (slot.state === "idle") clearTimeout(slot.timer);
    if (slot.state !== "starting") void retire(slot.worker);
  };

  const execute = async (input: RunClaudeInput): Promise<RunClaudeOutput> => {
    input.signal?.throwIfAborted();
    const plan = launchPlan(input);
    const key = input.sessionId;
    const cached = key ? slots.get(key) : undefined;
    let reservation: ProcessSlot | undefined;
    let worker: ClaudeProcess | undefined;
    let continuation = false;
    if (key && cached?.state === "idle") {
      if (cached.worker.isAlive() && Date.now() - cached.worker.createdAt < maxAgeMs &&
          cached.worker.fingerprint === plan.fingerprint && cached.worker.canContinue(input)) {
        clearTimeout(cached.timer);
        worker = cached.worker;
        continuation = true;
        reservation = { state: "busy", worker };
        slots.set(key, reservation);
      } else remove(key, cached);
    }
    if (key && !worker && !slots.has(key)) {
      if (slots.size >= maxWorkers) {
        const victim = [...slots.entries()]
          .filter((entry): entry is [string, Extract<ProcessSlot, { state: "idle" }>] => entry[1].state === "idle")
          .sort((left, right) => left[1].worker.lastUsed - right[1].worker.lastUsed)[0];
        if (victim) remove(...victim);
      }
      if (slots.size < maxWorkers) {
        reservation = { state: "starting" };
        slots.set(key, reservation);
      }
    }
    try {
      if (!worker) {
        worker = await ClaudeProcess.create(input, plan);
        workers.add(worker);
        input.signal?.throwIfAborted();
        if (key && reservation && slots.get(key) === reservation) {
          reservation = { state: "busy", worker };
          slots.set(key, reservation);
        }
      }
      const output = await worker.run(input, continuation);
      if (key && reservation && slots.get(key) === reservation && !shutdown.signal.aborted && worker.commit(input, output)) {
        const idle: ProcessSlot = { state: "idle", worker, timer: setTimeout(() => remove(key, idle),
          Math.max(0, maxAgeMs - (Date.now() - worker.createdAt))) };
        idle.timer.unref();
        slots.set(key, idle);
      } else {
        if (key && reservation) remove(key, reservation);
        await retire(worker);
      }
      return output;
    } catch (error) {
      if (key && reservation) remove(key, reservation);
      if (worker) await retire(worker);
      throw error;
    }
  };

  return {
    run(input: RunClaudeInput): Promise<RunClaudeOutput> {
      if (shutdown.signal.aborted) return Promise.reject(new Error("Claude Code runner is closed"));
      const signal = input.signal ? AbortSignal.any([input.signal, shutdown.signal]) : shutdown.signal;
      const task = execute({ ...input, signal });
      active.add(task);
      task.then(() => active.delete(task), () => active.delete(task));
      return task;
    },
    close(): Promise<void> {
      return closeTask ??= (async () => {
        shutdown.abort();
        for (const [key, slot] of slots) remove(key, slot);
        await Promise.allSettled([...workers].map(retire));
        await Promise.allSettled([...active]);
        await Promise.allSettled([...closing]);
      })();
    },
  };
}

export async function runClaudeRequest(input: RunClaudeInput): Promise<RunClaudeOutput> {
  input.signal?.throwIfAborted();
  const plan = launchPlan(input);
  const worker = await ClaudeProcess.create(input, plan);
  try {
    return await worker.run(input);
  } finally {
    await worker.close();
  }
}
