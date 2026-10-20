export function claudeModelName(entry: DiscoveredClaudeModel): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:\[1m\])?$/u.exec(entry.resolvedModel ?? entry.value);
  if (!match) return entry.displayName;
  const [, family, major, minor] = match;
  return `Claude ${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

export interface DiscoveredClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
}
