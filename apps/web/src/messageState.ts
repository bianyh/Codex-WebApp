import type { Item } from "./types";
import { createCommandId } from "./commandId";

const optimisticUserPrefix = "local-user-";

function optimisticUserId(): string {
  return `${optimisticUserPrefix}${createCommandId()}`;
}

export function createOptimisticUserItem(text: string, attachmentNames: string[] = []): Item {
  const attachmentText = attachmentNames.length
    ? `附件：${attachmentNames.join("、")}`
    : "";
  return {
    id: optimisticUserId(),
    kind: "user",
    createdAt: new Date().toISOString(),
    text: text || attachmentText,
  };
}

export function textFromRawItem(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.text === "string") return raw.text;
  const result = raw.result && typeof raw.result === "object" ? raw.result as Record<string, unknown> : undefined;
  const content = raw.content ?? raw.contentItems ?? raw.output ?? result?.content ?? raw.result ?? raw.error;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content && typeof content === "object" ? JSON.stringify(content, null, 2) : undefined;
  const text = content.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const value = entry as Record<string, unknown>;
    return typeof value.text === "string" ? value.text : "";
  }).join("");
  return text || undefined;
}

/**
 * Upserts an app-server item and reconciles the temporary user item inserted
 * by the composer before the server has persisted the message.
 */
export function mergeTimelineItem(items: Item[], incoming: Item): Item[] {
  const existingIndex = items.findIndex((item) => item.id === incoming.id);
  if (existingIndex >= 0) {
    const next = [...items];
    next[existingIndex] = { ...next[existingIndex], ...incoming };
    return next;
  }

  if (incoming.kind === "user") {
    const optimisticIndex = items.findIndex((item) =>
      item.kind === "user" &&
      item.id.startsWith(optimisticUserPrefix) &&
      (!incoming.text || item.text === incoming.text),
    );
    if (optimisticIndex >= 0) {
      const next = [...items];
      next[optimisticIndex] = {
        ...items[optimisticIndex],
        ...incoming,
        text: incoming.text || items[optimisticIndex]!.text,
        queueId: undefined,
      };
      return next;
    }
  }

  return [...items, incoming];
}
