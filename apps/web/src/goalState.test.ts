import { describe, expect, it } from "vitest";
import { goalStateFromEvent, goalStatusLabels, parseGoalBudget } from "./goalState";
import type { GoalState } from "./types";

describe("goal presentation", () => {
  it("receives updates without dropping read-only controls or mismatching threads", () => {
    const current: GoalState = { goal: null, supported: true, canControl: false, controlReason: "external owner" };
    const event = { method: "thread/goal/updated", params: { goal: { threadId: "t1", objective: "Implement", status: "budgetLimited", tokensUsed: 50, tokenBudget: 50, timeUsedSeconds: 60 } } };
    expect(goalStateFromEvent(current, event, "t1")).toMatchObject({ canControl: false, controlReason: "external owner", goal: { status: "budgetLimited", objective: "Implement" } });
    expect(goalStateFromEvent(current, event, "t2")).toBe(current);
  });
  it("clears deleted goals and labels every known lifecycle status", () => {
    expect(goalStateFromEvent(null, { method: "thread/goal/cleared", params: {} }, "t1")).toEqual({ goal: null, supported: true, canControl: false });
    expect(Object.keys(goalStatusLabels)).toEqual(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete", "unknown"]);
  });
  it("parses blank/unlimited and rejects invalid budget input", () => {
    expect(parseGoalBudget("")).toBeNull();
    expect(parseGoalBudget(" 1200 ")).toBe(1200);
    for (const value of ["0", "-1", "1.5", "1e3", "invalid", "9007199254740992"]) expect(() => parseGoalBudget(value)).toThrow();
  });
});
