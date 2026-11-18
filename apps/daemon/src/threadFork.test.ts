import { describe, expect, it, vi } from "vitest";
import { CodexProcess, snapshotFromRaw } from "./codex.js";
import { threadForkSchema } from "./threadFork.js";

describe("conversation branch boundaries", () => {
  it("preserves turn IDs on user, tool and answer items in persisted history", () => {
    const snapshot = snapshotFromRaw({ id: "thread", turns: [
      { id: "first", status: "completed", items: [{ id: "u1", type: "userMessage" }, { id: "tool", type: "commandExecution" }, { id: "a1", type: "agentMessage" }] },
      { id: "second", status: "completed", items: [{ id: "u2", type: "userMessage" }, { id: "a2", type: "agentMessage" }] },
    ] });
    expect(snapshot.items.map((item) => [item.id, item.turnId])).toEqual([["u1", "first"], ["tool", "first"], ["a1", "first"], ["u2", "second"], ["a2", "second"]]);
    expect(snapshot.items[2]?.status).toBe("final_answer");
    expect(snapshotFromRaw({ id: "legacy", turns: [{ items: [{ id: "old", type: "userMessage" }] }] }).items[0]?.turnId).toBeUndefined();
  });

  it("accepts exactly one boundary or the existing whole-thread action", () => {
    expect(threadForkSchema.parse({})).toEqual({});
    expect(threadForkSchema.parse({ lastTurnId: "first" })).toEqual({ lastTurnId: "first" });
    expect(threadForkSchema.parse({ beforeTurnId: "second" })).toEqual({ beforeTurnId: "second" });
    for (const input of [{ lastTurnId: "first", beforeTurnId: "second" }, { beforeTurnId: "" }, { lastTurnId: " " }, { beforeTurnId: 4 }, { lastTurnId: "a".repeat(513) }, { itemId: "unknown" }]) {
      expect(threadForkSchema.safeParse(input).success).toBe(false);
    }
  });

  for (const boundary of [{ lastTurnId: "first" }, { beforeTurnId: "second" }, {}]) {
    it(`forks with the exact boundary ${JSON.stringify(boundary)} without altering the source`, async () => {
      const adapter = new CodexProcess();
      const rpc = vi.spyOn(adapter, "request").mockImplementation(async (method) => method === "thread/fork"
        ? { thread: { id: "new" }, model: "inherited" }
        : { thread: { id: "new", turns: [{ id: "first", status: "completed", items: [{ id: "a1", type: "agentMessage", text: "Preserved" }] }] } });
      const result = await adapter.forkThread("source", boundary);
      expect(rpc).toHaveBeenCalledWith("thread/fork", { threadId: "source", ...boundary, excludeTurns: true, deferGoalContinuation: true });
      expect(result).toMatchObject({ thread: { id: "new", canRetry: true, runtimeSettings: { model: "inherited" } }, items: [{ turnId: "first" }] });
      expect(rpc.mock.calls.filter(([method]) => method !== "thread/fork").every(([method, params]) => method === "thread/read" && (params as { threadId: string }).threadId === "new")).toBe(true);
    });
  }

  it("does not retry by copying all history if the selected boundary fails", async () => {
    const adapter = new CodexProcess();
    const rpc = vi.spyOn(adapter, "request").mockRejectedValue(new Error("Selected turn is missing"));
    await expect(adapter.forkThread("source", { beforeTurnId: "removed" })).rejects.toThrow("Selected turn is missing");
    expect(rpc).toHaveBeenCalledOnce();
    rpc.mockClear();
    await expect(adapter.forkThread("source", { beforeTurnId: "one", lastTurnId: "two" })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
