import type { Item } from "./types";

const optimisticUserPrefix = "local-user-";

function optimisticUserId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${optimisticUserPrefix}${random}`;
}

export function createOptimisticUserItem(text: string, attachmentNames: string[] = []): Item {
  const attachmentText = attachmentNames.length
    ? `附件：${attachmentNames.join("、")}`
    : "";
  return {
    id: optimisticUserId(),
    kind: "user",
    text: text || attachmentText,
  };
}

export function textFromRawItem(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.text === "string") return raw.text;
  const content = raw.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
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
      next[optimisticIndex] = incoming;
      return next;
    }
  }

  return [...items, incoming];
}
