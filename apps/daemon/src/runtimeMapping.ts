import type { RuntimeSettings, TimelineItem, TokenUsage, StatusSection, Quota } from "./types.js";

export const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];

export function runtimeSettingsFromRaw(raw: unknown): RuntimeSettings {
  const value = record(raw);
  const mode = record(value.collaborationMode).mode;
  const sandbox = record(value.sandboxPolicy ?? value.sandbox).type;
  return {
    model: str(value.model), modelProvider: str(value.modelProvider), effort: str(value.effort ?? value.reasoningEffort),
    serviceTier: str(value.serviceTier) ?? (value.serviceTier === null ? "default" : undefined),
    mode: mode === "plan" || mode === "default" ? mode : undefined,
    approvalPolicy: str(value.approvalPolicy) ?? str(record(value.approvalPolicy).type), sandbox: str(sandbox),
  };
}

export function mapTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = record(raw);
  const breakdown = (raw: unknown) => {
    const value = record(raw);
    return { input: num(value.inputTokens ?? value.input), output: num(value.outputTokens ?? value.output), total: num(value.totalTokens ?? value.total),
      ...(num(value.cachedInputTokens) !== undefined ? { cachedInput: num(value.cachedInputTokens) } : {}),
      ...(num(value.reasoningOutputTokens) !== undefined ? { reasoningOutput: num(value.reasoningOutputTokens) } : {}) };
  };
  return { ...breakdown(usage.total && typeof usage.total === "object" ? usage.total : usage),
    ...(Object.keys(record(usage.last)).length ? { last: breakdown(usage.last) } : {}),
    ...(num(usage.modelContextWindow) ? { modelContextWindow: num(usage.modelContextWindow) } : {}) };
}

function safeLink(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; }
}

/** Only presentation fields cross the browser boundary; never forward raw arguments/config. */
export function structuredItem(raw: unknown): Partial<TimelineItem> | null {
  const value = record(raw);
  const durationMs = num(value.durationMs);
  if (value.type === "collabAgentToolCall" || value.type === "subAgentActivity") {
    const states = record(value.agentsStates);
    const ids = Array.isArray(value.receiverThreadIds) ? value.receiverThreadIds.filter((id): id is string => typeof id === "string") : typeof value.agentThreadId === "string" ? [value.agentThreadId] : [];
    return { kind: "agents", title: str(value.tool ?? value.kind) ?? "子代理", text: str(value.prompt), status: str(value.status),
      agentThreads: ids.map((id) => ({ id, name: str(value.agentPath), status: str(record(states[id]).status), message: str(record(states[id]).message) })) };
  }
  if (value.type === "webSearch") {
    const action = record(value.action);
    const candidates = [...rows(value.results), ...(action.url ? [{ url: action.url }] : [])];
    return { kind: "search", title: "网络搜索", text: str(value.query ?? action.query ?? action.pattern), links: candidates.flatMap((result) => {
      const url = safeLink(result.url ?? result.link); return url ? [{ url, title: str(result.title) ?? url, snippet: str(result.snippet ?? result.description) }] : [];
    }) };
  }
  if (value.type === "imageView" || value.type === "imageGeneration") {
    const result = str(value.result);
    // Limit inline payload and accept only raster formats, never SVG/HTML or remote URLs.
    const imageData = result && result.length < 16 * 1024 * 1024 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(result) ? result
      : result && result.length < 16 * 1024 * 1024 && /^[A-Za-z0-9+/=]{80,}$/.test(result) ? `data:image/png;base64,${result}` : undefined;
    return { kind: "image", title: value.type === "imageView" ? "查看图片" : "生成图片", path: str(value.savedPath ?? value.path), imageData,
      status: str(value.status), text: str(value.revisedPrompt) ?? str(record(value.failure).message) };
  }
  if (value.type === "enteredReviewMode" || value.type === "exitedReviewMode") return { kind: "review", title: value.type === "enteredReviewMode" ? "开始审查" : "审查结果", text: str(value.review) };
  if (value.type === "sleep") return { kind: "sleep", title: "等待", durationMs, text: durationMs === undefined ? undefined : `等待 ${(durationMs / 1000).toLocaleString()} 秒` };
  if (value.type === "contextCompaction") return { kind: "compaction", title: "上下文压缩", text: "Codex 正在整理上下文", status: str(value.status) };
  if (value.type === "hookPrompt") return { kind: "mcp", title: "Hook 上下文", text: rows(value.fragments).map((part) => str(part.text) ?? "").join("\n") };
  return null;
}

export function inventoryFromRaw(kind: "mcp" | "skills" | "plugins" | "hooks", raw: unknown): StatusSection {
  const value = record(raw);
  const groups = rows(value.data);
  let entries: StatusSection["entries"];
  if (kind === "mcp") entries = groups.map((server) => ({ id: String(server.name ?? ""), name: String(server.name ?? "MCP"), status: str(server.runtimeStatus) ?? str(server.authStatus), toolCount: Object.keys(record(server.tools)).length, ...(server.toolsError ? { description: "工具发现失败；请在本机检查 Codex 配置" } : {}) }));
  else if (kind === "plugins") entries = rows(value.marketplaces).flatMap((market) => rows(market.plugins).filter((plugin) => plugin.installed === true).map((plugin) => ({ id: String(plugin.id ?? ""), name: String(plugin.name ?? plugin.id ?? "Plugin"), status: plugin.enabled === true ? "enabled" : "disabled" })));
  else entries = groups.flatMap((group) => rows(group[kind]).map((entry) => ({ id: String(entry.path ?? entry.key ?? entry.name ?? ""), name: String(entry.name ?? entry.eventName ?? entry.key ?? kind), status: entry.enabled === false ? "disabled" : str(entry.trustStatus) ?? "enabled", path: str(entry.path ?? entry.sourcePath), description: kind === "skills" ? str(entry.shortDescription ?? entry.description) : str(entry.handlerType) })));
  // Errors may contain credentials/command lines; present only a count, not raw payloads.
  const problems = groups.reduce((count, group) => count + rows(group.errors).length + (Array.isArray(group.warnings) ? group.warnings.length : 0), 0) + rows(value.marketplaceLoadErrors).length;
  return { available: true, entries, error: problems ? `${problems} 项加载警告或错误；请在本机检查 Codex 配置` : undefined };
}

export function quotasFromRaw(raw: unknown): { available: boolean; ordinaryUsageAllowed?: boolean | null; entries: Quota[] } {
  const value = record(raw);
  const buckets = Object.values(record(value.rateLimitsByLimitId));
  if (!buckets.length && value.rateLimits) buckets.push(value.rateLimits);
  const window = (raw: unknown) => { const value = record(raw); const usedPercent = num(value.usedPercent); return usedPercent === undefined ? undefined : { usedPercent, windowDurationMins: num(value.windowDurationMins), resetsAt: num(value.resetsAt) }; };
  return { available: true, ordinaryUsageAllowed: typeof value.ordinaryUsageAllowed === "boolean" ? value.ordinaryUsageAllowed : null,
    entries: buckets.map((raw, index) => { const bucket = record(raw); return { id: str(bucket.limitId) ?? String(index), name: str(bucket.limitName ?? bucket.limitId) ?? "Codex", planType: str(bucket.planType), reached: str(bucket.rateLimitReachedType), primary: window(bucket.primary), secondary: window(bucket.secondary) }; }) };
}
