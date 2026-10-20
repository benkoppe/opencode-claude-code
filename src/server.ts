import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describeUsageCreditsRejection } from "./billing.ts";
import { runClaudeRequest, type RunClaudeInput, type RunClaudeOutput } from "./claude-cli.ts";
import type { AnthropicStreamEvent } from "./native-types.ts";
import { prepareRequest, TOOL_PREFIX, type MessagesRequest } from "./transcript.ts";

export interface ReplayMetadata {
  initialUserPrefix?: unknown[];
  initialSystemMessages?: unknown[];
}

export interface ServerOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  loadReplay?: (key: string) => Promise<ReplayMetadata | undefined>;
  saveReplay?: (key: string, value: ReplayMetadata) => Promise<void>;
  // Dependency injection only for the same local fixtures Pi uses in its tests.
  run?: (input: RunClaudeInput) => Promise<RunClaudeOutput>;
}

export function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return describeUsageCreditsRejection(message) ?? message;
}

export async function startServer(options: ServerOptions) {
  const prefix = `/${randomBytes(32).toString("base64url")}`;
  const active = new Map<AbortController, Promise<void>>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== `${prefix}/v1/messages` || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once("close", abort);
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as MessagesRequest;
        const input = prepareRequest(body);
        const session = String(request.headers["x-opencode-session"] ?? "");
        // A compacted or edited initial context gets its own replay prefix.
        const key = "replay/" + createHash("sha256").update(JSON.stringify([
          session, input.model, input.systemPrompt, input.frames[0]?.message,
        ], (field, value) => field === "cache_control" ? undefined : value)).digest("hex");
        const replay = session ? await options.loadReplay?.(key) : undefined;
        controller.signal.throwIfAborted();
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const terminal: AnthropicStreamEvent[] = [];
        let holdingTools = false;
        const emit = (event: AnthropicStreamEvent) => {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const output = await (options.run ?? runClaudeRequest)({
          ...input,
          ...replay,
          cwd: options.cwd,
          env: options.env,
          signal: controller.signal,
          betas: String(request.headers["anthropic-beta"] ?? "").split(",").filter(Boolean),
          onEvent(event) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
              const tool = event.content_block;
              const name = tool.name.slice(TOOL_PREFIX.length);
              if (tool.name.startsWith(TOOL_PREFIX) && input.toolNames.has(name)) {
                event = { ...event, content_block: { ...tool, name } };
              }
              holdingTools = true;
            }
            // Do not report success until the CLI's billing guard has run.
            if (holdingTools || event.type === "message_delta" || event.type === "message_stop") terminal.push(event);
            else emit(event);
          },
        });
        if (session) await options.saveReplay?.(key, {
          initialUserPrefix: output.initialUserPrefix,
          initialSystemMessages: output.initialSystemMessages,
        });
        for (const event of terminal) emit(event);
        response.end();
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = normalizeError(error);
        if (response.headersSent) {
          const event = { type: "error", error: { type: "invalid_request_error", message } };
          response.end(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
        } else {
          response.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
          );
        }
      } finally {
        response.off("close", abort);
        active.delete(controller);
      }
    })();
    active.set(controller, operation);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}/v1`,
    async close() {
      for (const controller of active.keys()) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...active.values()]);
    },
  };
}
