import { z } from "zod";

export const threadForkSchema = z.object({
  lastTurnId: z.string().trim().min(1).max(512).optional(),
  beforeTurnId: z.string().trim().min(1).max(512).optional(),
}).strict().refine((input) => !(input.lastTurnId && input.beforeTurnId), "只能选择一个分支位置");

export type ThreadForkInput = z.infer<typeof threadForkSchema>;
