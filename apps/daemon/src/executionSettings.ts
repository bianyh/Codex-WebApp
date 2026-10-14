import { z } from "zod";
import type { ExecutionSettings } from "./types.js";
export const executionSettingsSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  serviceTier: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["default", "plan"]).optional(),
});
export function executionParams(settings: ExecutionSettings, effectiveModel?: string): Record<string, unknown> {
  const input = executionSettingsSchema.parse(settings);
  const model = input.model ?? effectiveModel;
  if (input.mode && !model) throw new Error("切换计划模式需要先选择模型");
  const { mode, ...rest } = input;
  return { ...rest, ...(mode ? { collaborationMode: { mode, settings: { model, reasoning_effort: input.effort ?? null, developer_instructions: null } } } : {}) };
}
