import { open, stat } from "node:fs/promises";
import type { ThreadStatus, ThreadSummary } from "./types.js";

export type ThreadActivity = {
  threadId: string;
  status: ThreadStatus;
  activeTurnId?: string;
  canInterrupt: boolean;
  activitySource?: "console" | "external";
  observedAt: string;
};

type CachedActivity = ThreadActivity & {
  size: number;
  mtimeMs: number;
  rolloutStatus: ThreadStatus;
  rolloutTurnId?: string;
};

type ExternalOwner = {
  active: boolean;
  kind: "cli" | "app-server";
};

const ACTIVITY_EVENT_TYPES = new Set([
  "task_started",
  "turn_started",
  "task_complete",
  "turn_complete",
  "turn_aborted",
]);

function isTurnActiveStatus(status: ThreadStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_input";
}

export function parseLatestRolloutActivity(threadId: string, text: string): Omit<ThreadActivity, "canInterrupt" | "activitySource" | "observedAt"> | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.includes('"type"')) continue;
    try {
      const record = JSON.parse(line) as { payload?: Record<string, unknown> };
      const payload = record.payload;
      const type = typeof payload?.type === "string" ? payload.type : "";
      if (!ACTIVITY_EVENT_TYPES.has(type)) continue;
      const turnId = typeof payload?.turn_id === "string" ? payload.turn_id : typeof payload?.id === "string" ? payload.id : undefined;
      if (type === "task_started" || type === "turn_started") return { threadId, status: "running", activeTurnId: turnId };
      if (type === "turn_aborted") return { threadId, status: "interrupted" };
      return { threadId, status: "idle" };
    } catch {
      continue;
    }
  }
  return null;
}

async function readTail(filename: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const metadata = await stat(filename);
  const length = Math.min(metadata.size, maxBytes);
  if (length === 0) return "";
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, metadata.size - length);
    let value = buffer.subarray(0, bytesRead).toString("utf8");
    if (metadata.size > length) {
      const newline = value.indexOf("\n");
      if (newline >= 0) value = value.slice(newline + 1);
    }
    return value;
  } finally {
    await handle.close();
  }
}

export class ThreadActivityTracker {
  private cache = new Map<string, CachedActivity>();

  constructor(
    private readonly ownsTurn: (threadId: string, turnId?: string) => boolean,
    private readonly externalOwner: (
      rolloutPath?: string,
    ) => Promise<ExternalOwner | null>,
  ) {}

  async inspect(thread: ThreadSummary): Promise<ThreadActivity> {
    const consoleOwned = this.ownsTurn(thread.id, thread.activeTurnId);
    const fallbackStatus =
      isTurnActiveStatus(thread.status) && !consoleOwned ? "idle" : thread.status;
    const fallback: ThreadActivity = {
      threadId: thread.id,
      status: fallbackStatus,
      activeTurnId: isTurnActiveStatus(fallbackStatus)
        ? thread.activeTurnId
        : undefined,
      canInterrupt: isTurnActiveStatus(fallbackStatus) && consoleOwned,
      activitySource: isTurnActiveStatus(fallbackStatus) ? "console" : undefined,
      observedAt: new Date().toISOString(),
    };
    if (!thread.rolloutPath) return fallback;
    try {
      const metadata = await stat(thread.rolloutPath);
      const owner = await this.externalOwner(thread.rolloutPath);
      const cached = this.cache.get(thread.id);
      if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
        const owned = this.ownsTurn(thread.id, cached.rolloutTurnId);
        const externallyActive = Boolean(
          owner?.active ||
          (owner?.kind === "app-server" && cached.rolloutStatus === "running"),
        );
        const status =
          owned || externallyActive
            ? owned && isTurnActiveStatus(thread.status) ? thread.status : "running"
            : cached.rolloutStatus === "running"
              ? "idle"
              : cached.rolloutStatus;
        return {
          threadId: cached.threadId,
          status,
          activeTurnId: isTurnActiveStatus(status)
            ? (owned ? cached.rolloutTurnId ?? thread.activeTurnId : cached.rolloutTurnId)
            : undefined,
          canInterrupt: isTurnActiveStatus(status) && (owned || externallyActive),
          activitySource:
            isTurnActiveStatus(status) ? (owned ? "console" : "external") : undefined,
          observedAt: new Date().toISOString(),
        };
      }
      const parsed = parseLatestRolloutActivity(thread.id, await readTail(thread.rolloutPath));
      const owned = this.ownsTurn(thread.id, parsed?.activeTurnId);
      const externallyActive = Boolean(
        owner?.active ||
        (owner?.kind === "app-server" && parsed?.status === "running"),
      );
      const parsedStatus = parsed?.status ?? thread.status;
      const status =
        owned || externallyActive
          ? owned && isTurnActiveStatus(thread.status) ? thread.status : "running"
          : parsedStatus === "running"
            ? "idle"
            : parsedStatus;
      const activeTurnId = isTurnActiveStatus(status)
        ? (owned ? parsed?.activeTurnId ?? thread.activeTurnId : parsed?.activeTurnId)
        : undefined;
      const canInterrupt = isTurnActiveStatus(status) && (owned || externallyActive);
      const activity: CachedActivity = {
        threadId: thread.id,
        status,
        activeTurnId,
        canInterrupt,
        activitySource:
          isTurnActiveStatus(status) ? (owned ? "console" : "external") : undefined,
        observedAt: new Date().toISOString(),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        rolloutStatus: parsedStatus,
        rolloutTurnId: parsed?.activeTurnId,
      };
      this.cache.set(thread.id, activity);
      return activity;
    } catch {
      return fallback;
    }
  }

  async enrich(thread: ThreadSummary): Promise<ThreadSummary> {
    const activity = await this.inspect(thread);
    return {
      ...thread,
      status: activity.status,
      activeTurnId: activity.activeTurnId,
      canInterrupt: activity.canInterrupt,
      activitySource: activity.activitySource,
    };
  }
}
