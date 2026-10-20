// OpenCode's Anthropic transport already lowers history into native Messages blocks.
// Only the CLI's inert MCP naming and schema normalization are added here.
import type { NativeFrame } from "./native-types.ts";

export const TOOL_PREFIX = "mcp__opencode__";

export interface NativeSystemInjection {
  beforeAssistant: number | null;
  content: Array<Record<string, unknown>>;
  fields?: Record<string, unknown>;
}

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function withoutNullVariant(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutNullVariant);
  if (!schema || typeof schema !== "object") return schema;
  const output = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, withoutNullVariant(value)]),
  );
  if (Array.isArray(output.type) && output.type.includes("null")) {
    const remaining = output.type.filter((value) => value !== "null");
    output.type = remaining.length === 1 ? remaining[0] : remaining;
  }
  if (Array.isArray(output.anyOf)) {
    const nonNull = output.anyOf.filter(
      (branch) => !(branch && typeof branch === "object" && branch.type === "null"),
    );
    if (nonNull.length === 1 && nonNull.length !== output.anyOf.length) {
      delete output.anyOf;
      Object.assign(output, nonNull[0]);
    }
  }
  return output;
}

export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const normalized = withoutNullVariant(schema) as Record<string, unknown>;
  for (const key of ["oneOf", "allOf", "anyOf"]) delete normalized[key];
  if (!normalized.type) normalized.type = "object";
  if (normalized.type === "object" && (!normalized.properties || typeof normalized.properties !== "object")) {
    normalized.properties = {};
  }
  return normalized;
}

export interface MessagesRequest {
  model: string;
  system?: string | Array<{ type: string; text: string }>;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string | Array<Record<string, unknown>>; [key: string]: unknown }>;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}

// Rename only protocol tool names, never strings inside tool inputs/results.
function nativeBlocks(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.map((source) => {
    const block = structuredClone(source);
    // Claude Code and Pi's replay relay own the four available cache markers.
    delete block.cache_control;
    if (block.type === "tool_use" || block.type === "tool_reference") block.name = `${TOOL_PREFIX}${block.name}`;
    if ((block.type === "tool_addition" || block.type === "tool_removal") && block.tool) {
      block.tool = nativeBlocks([block.tool as Record<string, unknown>])[0];
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      block.content = nativeBlocks(block.content);
    }
    return block;
  });
}

export function prepareRequest(request: MessagesRequest) {
  const names = new Set<string>();
  const manifest: ToolManifestEntry[] = [];
  const nativeTools = (request.tools ?? []).map((tool) => {
    if (!/^[A-Za-z0-9_-]{1,50}$/u.test(tool.name) || names.has(tool.name)) {
      throw new Error("Claude Code tool names must be unique ASCII identifiers of at most 50 characters");
    }
    names.add(tool.name);
    const schema = normalizeInputSchema(tool.input_schema);
    manifest.push({ name: tool.name, description: tool.description ?? "", inputSchema: schema });
    const { cache_control: _cache, ...definition } = tool;
    return { ...definition, name: `${TOOL_PREFIX}${tool.name}`, input_schema: schema };
  });

  const frames: NativeFrame[] = [];
  const injections: NativeSystemInjection[] = [];
  let assistantOrdinal = 0;
  let pending: Array<{ content: Array<Record<string, unknown>>; fields: Record<string, unknown> }> = [];
  for (const message of request.messages) {
    const content = nativeBlocks(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
    if (message.role === "system") {
      const { role: _role, content: _content, ...fields } = message;
      pending.push({ content, fields });
      continue;
    }
    if (message.role === "assistant") {
      for (const update of pending) injections.push({ beforeAssistant: assistantOrdinal, ...update });
      pending = [];
      assistantOrdinal++;
    }
    const previous = frames.at(-1);
    if (message.role === "user" && previous?.type === "user") previous.message.content.push(...content);
    else frames.push({ type: message.role, message: { role: message.role, content } });
  }
  for (const update of pending) injections.push({ beforeAssistant: null, ...update });
  if (frames.at(-1)?.type !== "user" || !frames.at(-1)?.message.content.length) {
    throw new Error("Claude Code history must end in a non-empty user or tool-result message");
  }
  for (let index = 0; index < frames.length - 1; index++) {
    if (frames[index]!.type === "user") frames[index]!.shouldQuery = false;
  }

  const { model, messages: _messages, system, tools: _tools, stream: _stream,
    metadata: _metadata, cache_control: _cache, ...options } = request;
  const extraBody: Record<string, unknown> = { ...options, tools: nativeTools };
  const choice = extraBody.tool_choice as { type?: string; name?: string } | undefined;
  if (choice?.type === "tool" && choice.name) extraBody.tool_choice = { ...choice, name: `${TOOL_PREFIX}${choice.name}` };
  // Compaction remains OpenCode's job, never Claude Code's internal loop.
  if (!extraBody.thinking || (extraBody.thinking as { type?: string }).type === "disabled") {
    // An omitted preference belongs to Claude Code. Newer models no longer
    // accept the old forced "disabled" default used by the Pi reference.
    extraBody.context_management = { edits: [] };
  }
  return {
    model,
    frames,
    manifest,
    toolNames: names,
    systemPrompt: typeof system === "string" ? system : (system ?? []).map((part) => part.text).join("\n\n"),
    extraBody,
    nativeSystemInjections: injections.length ? injections : undefined,
  };
}
