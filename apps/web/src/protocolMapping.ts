import type { Snapshot } from "./types";

export function planFromRaw(value: unknown): NonNullable<Snapshot["plan"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ text: entry, completed: false }];
    if (!entry || typeof entry !== "object") return [];
    const step = entry as Record<string, unknown>;
    const text = typeof step.step === "string" ? step.step : typeof step.text === "string" ? step.text : "";
    return text ? [{ text, completed: step.status === "completed" || step.completed === true }] : [];
  });
}

export function tokenUsageFromRaw(value: unknown): Snapshot["tokenUsage"] {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const totals = usage.total && typeof usage.total === "object" ? usage.total as Record<string, unknown> : usage;
  const number = (candidate: unknown): number | undefined => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  return {
    input: number(totals.inputTokens ?? totals.input),
    output: number(totals.outputTokens ?? totals.output),
    total: number(totals.totalTokens ?? totals.total),
  };
}

export function changeStatusFromRaw(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string") return (value as Record<string, unknown>).type as string;
  return undefined;
}
