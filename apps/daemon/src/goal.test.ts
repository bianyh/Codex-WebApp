import { describe, expect, it, vi } from "vitest";
import { CodexProcess } from "./codex.js";
import { goalFromRaw, goalUnsupported, goalUpdateSchema } from "./goal.js";

const rawGoal = { threadId: "thread-1", objective: "Finish tests", status: "paused", tokenBudget: 1000, tokensUsed: 50, timeUsedSeconds: 12, createdAt: 1700000000, updatedAt: 1700000001 };

describe("goal adapter", () => {
  it("normalizes goal state and rejects another thread's target", () => {
    expect(goalFromRaw(rawGoal, "thread-1")).toMatchObject({ objective: "Finish tests", status: "paused", tokensUsed: 50, createdAt: "2023-11-14T22:13:20.000Z" });
    expect(() => goalFromRaw(rawGoal, "thread-2")).toThrow("不匹配");
    expect(goalFromRaw({ ...rawGoal, status: "futureStatus" }, "thread-1")?.status).toBe("unknown");
    expect(goalFromRaw(null, "thread-1")).toBeNull();
  });
  it("only permits user-controlled status changes and valid budgets", () => {
    for (const value of [{}, { objective: " " }, { tokenBudget: -1 }, { tokenBudget: 1.5 }, { tokenBudget: Number.MAX_SAFE_INTEGER + 1 }, { status: "complete" }, { origin: "automatic", status: "active" }]) {
      expect(goalUpdateSchema.safeParse(value).success).toBe(false);
    }
    expect(goalUpdateSchema.parse({ objective: " hello ", tokenBudget: null })).toEqual({ objective: "hello", tokenBudget: null });
  });
  it("maps reads without acquiring or resuming the external writer", async () => {
    const codex = new CodexProcess();
    const rpc = vi.spyOn(codex, "request").mockResolvedValue({ goal: rawGoal });
    await expect(codex.getGoal("thread-1")).resolves.toMatchObject({ status: "paused" });
    expect(rpc.mock.calls).toEqual([["thread/goal/get", { threadId: "thread-1" }]]);
  });
  it("sends explicit user provenance and does not resume during content-only edits", async () => {
    const codex = new CodexProcess();
    const rpc = vi.spyOn(codex, "request").mockImplementation(async (method) => method === "thread/goal/set" ? { goal: rawGoal } : {});
    await codex.setGoal("thread-1", { objective: "revised" });
    expect(rpc).toHaveBeenCalledWith("thread/goal/set", { threadId: "thread-1", objective: "revised", origin: "user" });
    await codex.clearGoal("thread-1");
    expect(rpc).toHaveBeenCalledWith("thread/goal/clear", { threadId: "thread-1", origin: "user" });
  });
  it("does not hide writer locks as unsupported-feature errors", () => {
    expect(goalUnsupported(new Error("unknown variant `thread/goal/get`"))).toBe(true);
    expect(goalUnsupported(new Error("thread already has an active writer"))).toBe(false);
  });
});
