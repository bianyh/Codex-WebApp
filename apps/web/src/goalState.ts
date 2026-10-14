import type { GoalState, GoalStatus, TimelineEvent } from "./types";

export const goalStatusLabels: Record<GoalStatus, string> = {
  active: "进行中", paused: "已暂停", blocked: "受阻", usageLimited: "使用额度受限", budgetLimited: "预算已耗尽", complete: "已完成", unknown: "未知状态",
};

export function goalStateFromEvent(current: GoalState | null, event: TimelineEvent, threadId: string): GoalState | null {
  if (event.method === "thread/goal/cleared") return { ...current, supported: true, canControl: current?.canControl ?? false, goal: null };
  if (event.method !== "thread/goal/updated") return current;
  const raw = event.params.goal;
  if (!raw || typeof raw !== "object") return current;
  const goal = raw as Record<string, unknown>;
  if (goal.threadId !== threadId || typeof goal.objective !== "string" || typeof goal.status !== "string") return current;
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    ...current, supported: true, canControl: current?.canControl ?? false,
    goal: {
      threadId, objective: goal.objective,
      status: Object.hasOwn(goalStatusLabels, goal.status) ? goal.status as GoalStatus : "unknown",
      tokenBudget: typeof goal.tokenBudget === "number" && Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0 ? goal.tokenBudget : null,
      tokensUsed: count(goal.tokensUsed), timeUsedSeconds: count(goal.timeUsedSeconds),
    },
  };
}

export function parseGoalBudget(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value.trim())) throw new Error("Token 预算必须为正整数，或留空表示不限预算");
  const budget = Number(value);
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Token 预算必须为正整数");
  return budget;
}
