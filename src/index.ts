import { Model, Plugin, Provider } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { discoverClaudeModels, getClaudeStatus } from "./claude-cli.ts";
import { claudeModelName } from "./model-catalog.ts";
import { startServer, type ReplayMetadata } from "./server.ts";

const providerID = Provider.ID.make("claude-code");

export default Plugin.define({
  id: "opencode-claude-code",
  effect: (ctx) => Effect.gen(function* () {
    const env: Record<string, string | undefined> = { ...process.env };
    if (typeof ctx.options.claudeCommand === "string") env.OPENCODE_CLAUDE_CODE_COMMAND = ctx.options.claudeCommand;
    if (typeof ctx.options.configDir === "string") env.OPENCODE_CLAUDE_CODE_CONFIG_DIR = ctx.options.configDir;
    if (typeof ctx.options.nodeCommand === "string") env.OPENCODE_CLAUDE_CODE_NODE_COMMAND = ctx.options.nodeCommand;

    const status = yield* Effect.tryPromise((signal) => getClaudeStatus(env, signal)).pipe(Effect.orDie);
    if (!status.available || !status.loggedIn) {
      yield* Effect.logWarning(status.detail ?? "Run claude auth login to enable the Claude Code provider.");
      return;
    }
    const catalog = yield* Effect.tryPromise((signal) => discoverClaudeModels(env, signal)).pipe(Effect.orDie);
    const bridge = yield* Effect.acquireRelease(
      Effect.promise(() => startServer({
        cwd: ctx.location.directory,
        env,
        loadReplay: (key) => Effect.runPromise(ctx.storage.get(key)).then((value) => value as ReplayMetadata | undefined),
        saveReplay: (key, value) => Effect.runPromise(ctx.storage.set(key, JSON.parse(JSON.stringify(value)))),
      })),
      (server) => Effect.promise(() => server.close()),
    );

    yield* ctx.provider.transform((editor) => {
      const anthropic = editor.get("anthropic");
      const models = catalog.map((entry) => {
        const resolved = (entry.resolvedModel ?? entry.value).replace(/\[1m\]$/u, "");
        const builtin = anthropic?.models.get(resolved);
        return {
          ...(builtin ?? Model.Info.default(providerID, Model.ID.make(entry.value))),
          id: Model.ID.make(entry.value),
          modelID: Model.ID.make(entry.value),
          providerID,
          name: claudeModelName(entry),
          enabled: true,
          package: "@opencode/ai/providers/anthropic",
          settings: { compaction: { type: "summary" as const } },
          limit: builtin?.limit ?? {
            context: /1M context/iu.test(entry.description) ? 1_000_000 : 200_000,
            output: 64_000,
          },
          variants: (entry.supportedEffortLevels ?? []).map((effort) => ({
            id: Model.VariantID.make(effort),
            settings: {
              thinking: entry.supportsAdaptiveThinking ? { type: "adaptive" } : { type: "enabled", budgetTokens: 10_000 },
              effort,
            },
          })),
        };
      });
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Claude Code",
          activation: "enabled",
          package: "@opencode/ai/providers/anthropic",
          settings: { baseURL: bridge.baseURL, apiKey: "external-process", compaction: { type: "summary" } },
        },
        models,
      });
    });
    yield* ctx.session.hook("model.request", (event) => Effect.sync(() => {
      // Never let a provider override redirect this subscription provider externally.
      event.baseURL = bridge.baseURL;
      event.headers["x-opencode-session"] = `${event.sessionID}/${event.kind}`;
    }), { providerID });
    yield* ctx.session.hook("retry", (event) => Effect.sync(() => {
      if (/billing|conflicting auth\/backend overrides/iu.test(event.error.message)) event.decision = { retry: false };
    }), { providerID });
  }),
});
