import { describe, expect, it } from "vitest";
import { inventoryFromRaw, mapTokenUsage, quotasFromRaw, runtimeSettingsFromRaw, structuredItem } from "./runtimeMapping.js";
import { executionParams, executionSettingsSchema } from "./executionSettings.js";
import { CodexProcess, itemFromRaw } from "./codex.js";
import { vi } from "vitest";

describe("runtime presentation", () => {
  it("keeps cumulative and last-turn context accounting distinct", () => {
    expect(mapTokenUsage({ total: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 600, reasoningOutputTokens: 30 }, last: { inputTokens: 40, outputTokens: 10, totalTokens: 50 }, modelContextWindow: 200 })).toMatchObject({ total: 1100, cachedInput: 600, reasoningOutput: 30, last: { total: 50 }, modelContextWindow: 200 });
    expect(mapTokenUsage({ modelContextWindow: -1, last: null })).not.toHaveProperty("modelContextWindow");
    expect(mapTokenUsage(undefined)).toBeUndefined();
  });
  it("sanitizes runtime settings and never exposes arbitrary configuration", () => {
    expect(runtimeSettingsFromRaw({ model: "m", effort: "high", serviceTier: null, collaborationMode: { mode: "plan", settings: { developer_instructions: "private" } }, sandboxPolicy: { type: "readOnly" }, credentials: "secret" })).toMatchObject({ model: "m", effort: "high", serviceTier: "default", mode: "plan", sandbox: "readOnly" });
    expect(JSON.stringify(runtimeSettingsFromRaw({ token: "secret" }))).not.toContain("secret");
  });
  it("maps agents, search, raster images, review and compaction without raw metadata", () => {
    expect(itemFromRaw({ id: "a", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "Done" } } })).toMatchObject({ kind: "agents", agentThreads: [{ id: "child", status: "completed", message: "Done" }] });
    expect(structuredItem({ type: "webSearch", query: "test", results: [{ url: "javascript:alert(1)" }, { url: "https://name:password@example.com" }, { title: "safe", url: "https://example.com" }] })).toMatchObject({ links: [{ title: "safe", url: "https://example.com/" }] });
    expect(structuredItem({ type: "imageGeneration", savedPath: "/tmp/p.png", result: "data:image/svg+xml;base64,abc" })).toMatchObject({ kind: "image", path: "/tmp/p.png", imageData: undefined });
    expect(structuredItem({ type: "imageGeneration", result: "data:image/png;base64,YWJj" })?.imageData).toBe("data:image/png;base64,YWJj");
    expect(itemFromRaw({ id: "r", type: "exitedReviewMode", review: "No issues" })).toMatchObject({ kind: "review", text: "No issues" });
    expect(itemFromRaw({ id: "c", type: "contextCompaction" }).kind).toBe("compaction");
    expect(itemFromRaw({ id: "x", type: "future", secret: "private" }).metadata).toBeUndefined();
    expect(itemFromRaw({ type: "commandExecution", exitCode: 1, durationMs: 1000 })).toMatchObject({ exitCode: 1, durationMs: 1000 });
  });
  it("whitelists status and quota fields without leaking keys, hook commands or account identity", () => {
    const mcp = inventoryFromRaw("mcp", { data: [{ name: "test", runtimeStatus: "failed", authStatus: "notLoggedIn", tools: { a: {} }, toolsError: "password=secret", env: { API_KEY: "secret" } }] });
    expect(mcp.entries[0]).toMatchObject({ name: "test", status: "failed", toolCount: 1 });
    const hooks = inventoryFromRaw("hooks", { data: [{ hooks: [{ key: "h", eventName: "sessionStart", enabled: true, command: "private", currentHash: "secret", handlerType: "command", trustStatus: "trusted" }], errors: [{ message: "secret" }] }] });
    expect(hooks.error).toContain("1");
    const quotas = quotasFromRaw({ ordinaryUsageAllowed: false, accountId: "secret", rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 90, resetsAt: 1234 }, credits: { balance: "secret" } } } });
    expect(quotas).toMatchObject({ ordinaryUsageAllowed: false, entries: [{ primary: { usedPercent: 90, resetsAt: 1234 } }] });
    for (const data of [mcp, hooks, quotas]) expect(JSON.stringify(data)).not.toMatch(/secret|private/);
  });
  it("only returns installed plugins and preserves disabled skills", () => {
    expect(inventoryFromRaw("plugins", { marketplaces: [{ plugins: [{ id: "a", name: "A", installed: true, enabled: false }, { id: "b", installed: false }] }] }).entries).toEqual([{ id: "a", name: "A", status: "disabled" }]);
    expect(inventoryFromRaw("skills", { data: [{ skills: [{ name: "S", path: "/s", enabled: false }] }] }).entries[0]?.status).toBe("disabled");
  });
});

describe("next-turn settings protocol", () => {
  it("uses native built-in plan mode instructions and omits inherited values", () => {
    expect(executionParams({})).toEqual({});
    expect(executionParams({ model: "test", effort: "high", serviceTier: "default", mode: "plan" })).toEqual({ model: "test", effort: "high", serviceTier: "default", collaborationMode: { mode: "plan", settings: { model: "test", reasoning_effort: "high", developer_instructions: null } } });
    expect(() => executionParams({ mode: "plan" })).toThrow("选择模型");
    expect(executionSettingsSchema.safeParse({ effort: "unsafe", mode: "agent" }).success).toBe(false);
  });
  it("sends native settings on turn start and does not emulate a system prompt", async () => {
    const adapter = new CodexProcess();
    const rpc = vi.spyOn(adapter, "request").mockImplementation(async (method) => method === "thread/resume" ? { model: "test" } : { turn: { id: "turn" } });
    await adapter.startTurn("t", { text: "hello", attachments: [] }, { mode: "plan", effort: "high", serviceTier: "default" });
    expect(rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "t", effort: "high", serviceTier: "default", collaborationMode: { mode: "plan", settings: { model: "test", reasoning_effort: "high", developer_instructions: null } } }));
  });
  it("supports paginated archived search and normal forks", async () => {
    const adapter = new CodexProcess();
    const rpc = vi.spyOn(adapter, "request").mockImplementation(async (method) => method === "thread/list" ? { data: [{ id: "t", name: "Found" }], nextCursor: "next" } : { thread: { id: "fork", turns: [] }, model: "test" });
    expect(await adapter.listThreadPage({ archived: true, searchTerm: "Found", cursor: "page" })).toMatchObject({ threads: [{ id: "t" }], nextCursor: "next" });
    expect(rpc).toHaveBeenCalledWith("thread/list", expect.objectContaining({ archived: true, searchTerm: "Found", cursor: "page" }));
    expect((await adapter.forkThread("t", "before")).thread.id).toBe("fork");
    expect(rpc).toHaveBeenCalledWith("thread/fork", { threadId: "t", lastTurnId: "before", excludeTurns: true });
  });
});
