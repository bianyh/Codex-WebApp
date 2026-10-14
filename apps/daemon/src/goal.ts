import { z } from "zod";
import type { Goal, GoalStatus } from "./types.js";

export const goalUpdateSchema = z.object({
  objective: z.string().trim().min(1, "目标内容不能为空").max(32000, "目标内容过长").optional(),
  status: z.enum(["active", "paused"]).optional(),
  tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "请指定需要修改的目标字段");

export type GoalUpdate = z.infer<typeof goalUpdateSchema>;

export function goalFromRaw(raw: unknown, threadId: string): Goal | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") throw new Error("Codex 返回了无效的目标数据");
  const value = raw as Record<string, unknown>;
  if (typeof value.objective !== "string" || typeof value.threadId !== "string" || value.threadId !== threadId || typeof value.status !== "string") throw new Error("Codex 返回的目标与当前线程不匹配");
  const statuses: GoalStatus[] = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"];
  const count = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : 0;
  const timestamp = (input: unknown): string | undefined => {
    if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
    const date = new Date(input * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  return {
    threadId,
    objective: value.objective,
    status: statuses.includes(value.status as GoalStatus) ? value.status as GoalStatus : "unknown",
    tokenBudget: typeof value.tokenBudget === "number" && value.tokenBudget > 0 && Number.isSafeInteger(value.tokenBudget) ? value.tokenBudget : null,
    tokensUsed: count(value.tokensUsed),
    timeUsedSeconds: count(value.timeUsedSeconds),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

export function goalUnsupported(error: unknown): boolean {
  return error instanceof Error && /unknown variant [`'"]thread\/goal\/|method not found|unknown method|goals? (?:is |are )?(?:not supported|disabled)|(?:requires|enable).*features\.goals/i.test(error.message);
}
