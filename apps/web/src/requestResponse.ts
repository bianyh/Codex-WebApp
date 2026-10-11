import type { RequestItem } from "./types";

export function responseForRequest(request: RequestItem, decision: string): Record<string, unknown> {
  if (request.kind === "permissions") {
    const permissions = decision === "accept" ? Object.fromEntries(Object.entries(request.permissions ?? {}).filter(([, value]) => value !== null)) : {};
    return { permissions, scope: "turn" };
  }
  if (request.kind === "elicitation") {
    return { action: decision === "accept" ? "accept" : "decline", content: decision === "accept" ? JSON.parse(request.detail ?? "{}") : null, _meta: null };
  }
  if (request.kind === "tool_call") return { success: false, contentItems: [{ type: "inputText", text: "该动态工具未在 Codex Console 中配置。请继续完成当前消息。" }] };
  if (request.kind === "user_input") {
    if (decision !== "answer") return { answers: {} };
    const parsed = JSON.parse(request.detail ?? "{}") as { answers?: Record<string, string>; freeText?: string };
    const answers = { ...parsed.answers };
    if (parsed.freeText?.trim() && request.questions?.[0]) answers[request.questions[0].id] = [answers[request.questions[0].id], parsed.freeText.trim()].filter(Boolean).join("\n");
    return { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: [value] }])) };
  }
  return { decision };
}
