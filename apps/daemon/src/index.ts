import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { stdin as processStdin } from "node:process";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { WebSocket } from "ws";
import { z } from "zod";
import { allowedOrigin, config } from "./config.js";
import { loadState, getCustomModels, getState, persistState, setCustomModels } from "./state.js";
import { authenticated, login, logout, requireAuth, setPassword } from "./auth.js";
import { CodexProcess, errorTextFromRaw, itemFromRaw, planFromRaw, statusFromRaw, summaryFromRaw, tokenUsageFromRaw } from "./codex.js";
import { goalFromRaw, goalUnsupported, goalUpdateSchema } from "./goal.js";
import { executionSettingsSchema } from "./executionSettings.js";
import { inventoryFromRaw, quotasFromRaw, runtimeSettingsFromRaw } from "./runtimeMapping.js";
import type { ExecutionSettings, QueueEntry, RuntimeInventory } from "./types.js";
import { ExternalCodexController } from "./externalCodex.js";
import { ThreadActivityTracker, type ThreadActivity } from "./threadActivity.js";
import { runWorkspaceCommand } from "./workspaceCommand.js";
import { resolveServerDirectory, resolveServerPath } from "./serverDirectory.js";
import type { ConsoleEvent, GoalState, ModelOption, ThreadSnapshot, ThreadStatus, ThreadSummary, TurnAttachment, TurnInput } from "./types.js";

const daemon = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const codex = new CodexProcess();
const sockets = new Set<WebSocket>();
const eventBuffer: ConsoleEvent[] = [];
const snapshots = new Map<string, ThreadSnapshot>();
const knownThreads = new Map<string, ThreadSummary>();
const lastActivities = new Map<string, ThreadActivity>();
const subscriptions = new Map<WebSocket, string>();
const goalStates = new Map<string, GoalState>();
const activeCompactions = new Set<string>();
const archivedIds = new Set<string>();
const externalCodex = new ExternalCodexController({
  isIgnoredPid: (pid) => pid === codex.pid,
});
type QueuedTurn = QueueEntry;
const queuedTurns = new Map<string, QueuedTurn[]>();
const drainingQueues = new Set<string>();
const turnOperations = new Map<string, Promise<void>>();
let refreshingActivities: Promise<void> | null = null;
let cachedOfficialModels: ModelOption[] = [];
const runningCommands = new Map<string, AbortController>();
const activityTracker = new ThreadActivityTracker(
  (threadId, turnId) => codex.ownsTurn(threadId, turnId),
  (rolloutPath) => externalCodex.ownerFor(rolloutPath),
);
let startedAt = Date.now();

function isTurnActiveStatus(status: ThreadStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_input";
}

function requestId(request: { id: string | number }): string { return String(request.id); }
function ok<T>(request: { id: string | number }, data: T) { return { ok: true, data, requestId: requestId(request) }; }
function failure(request: { id: string | number }, code: string, message: string, retryable = false) { return { ok: false, error: { code, message, retryable }, requestId: requestId(request) }; }

function publicThread(thread: ThreadSummary): ThreadSummary {
  const { rolloutPath: _rolloutPath, ...value } = thread;
  return value;
}

function publicSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return { ...snapshot, compaction: activeCompactions.has(snapshot.thread.id) ? "running" : snapshot.compaction, thread: publicThread(snapshot.thread), pendingRequests: codex.getPendingRequests(snapshot.thread.id), goalState: goalStates.get(snapshot.thread.id) };
}

async function readGoalState(threadId: string): Promise<GoalState> {
  if (!knownThreads.has(threadId)) {
    const result = await codex.request("thread/read", { threadId, includeTurns: false }) as { thread: unknown };
    const thread = summaryFromRaw(result.thread);
    if (!thread.id || thread.id !== threadId) throw new Error("线程不存在");
    knownThreads.set(threadId, thread);
  }
  const canControl = codex.controlsThread(threadId);
  const goal = await codex.getGoal(threadId);
  const state: GoalState = { goal, supported: true, canControl, controlReason: canControl ? undefined : "此线程由其他 Codex 窗口持有，或尚未由控制台接管。请在原窗口暂停/退出后重新打开线程；控制台不会强制关闭它。" };
  goalStates.set(threadId, state);
  return state;
}

function sendSocket(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(payload: unknown, threadId?: string): void {
  for (const socket of sockets) {
    if (threadId && subscriptions.get(socket) !== threadId) continue;
    sendSocket(socket, payload);
  }
}

const uploadRoot = path.join(config.dataDir, "uploads");
const maxUploadBytes = 25 * 1024 * 1024;

function customModelOption(model: string, displayName: string): ModelOption {
  return {
    id: `custom:${model}`,
    model,
    displayName,
    description: "自定义模型名称，由本机 Codex 配置的模型提供商解析",
    isDefault: false,
    isCustom: true,
    inputModalities: ["text", "image", "audio"],
  };
}

function mergeModels(official: ModelOption[]): ModelOption[] {
  const result = [...official];
  const known = new Set(official.map((entry) => entry.model));
  for (const entry of getCustomModels()) {
    if (known.has(entry.model)) continue;
    result.push(customModelOption(entry.model, entry.displayName));
    known.add(entry.model);
  }
  return result;
}

function queueState(threadId: string): void {
  broadcast({ type: "turn_queue_state", threadId, queue: queuedTurns.get(threadId) ?? [] }, threadId);
}
function queueTurn(threadId: string, input: TurnInput, settings: ExecutionSettings = {}): string {
  const id = randomUUID();
  const queue = queuedTurns.get(threadId) ?? [];
  if (queue.length >= 1000) throw new Error("此线程排队指令已达到上限，请先处理队列");
  queue.push({ id, ...input, ...settings, createdAt: new Date().toISOString() });
  queuedTurns.set(threadId, queue);
  broadcast(
    {
      type: "turn_queued",
      threadId,
      queuedId: id,
      queueLength: queue.length,
      text: input.text,
      attachments: input.attachments.map(({ name, kind, size }) => ({ name, kind, size })),
    },
    threadId,
  );
  queueState(threadId);
  return id;
}

function uploadKind(mime: string): TurnAttachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

async function resolveTurnInput(action: Record<string, unknown>): Promise<TurnInput> {
  const text = typeof action.text === "string" ? action.text.trim() : "";
  const rawAttachments = Array.isArray(action.attachments)
    ? action.attachments.slice(0, 8)
    : [];
  const attachments: TurnAttachment[] = [];
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  let canonicalRoot = await realpath(uploadRoot);
  for (const raw of rawAttachments) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    if (typeof value.path !== "string") continue;
    const canonicalPath = await realpath(value.path);
    if (
      canonicalPath !== canonicalRoot &&
      !canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)
    ) {
      throw new Error("附件不属于本控制台的上传目录");
    }
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile() || metadata.size > maxUploadBytes) {
      throw new Error("附件不存在或超过 25 MiB");
    }
    const mime =
      typeof value.mime === "string" && value.mime.length <= 160
        ? value.mime
        : "application/octet-stream";
    attachments.push({
      name:
        typeof value.name === "string" && value.name.trim()
          ? path.basename(value.name.trim()).slice(0, 180)
          : path.basename(canonicalPath),
      path: canonicalPath,
      mime,
      size: metadata.size,
      kind: uploadKind(mime),
    });
  }
  if (!text && attachments.length === 0) throw new Error("消息不能为空");
  return { text, attachments };
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function serializeTurnOperation(
  threadId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = turnOperations.get(threadId);
  const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(operation);
  turnOperations.set(threadId, current);
  try {
    await current;
  } finally {
    if (turnOperations.get(threadId) === current) turnOperations.delete(threadId);
  }
}

async function takeControl(thread: ThreadSummary): Promise<boolean> {
  if (await codex.tryTakeControl(thread.id)) return true;
  const owner = await externalCodex.ownerFor(thread.rolloutPath);
  if (!owner || owner.active) return false;
  await externalCodex.closeIdleOwner(thread.rolloutPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(250);
    if (await codex.tryTakeControl(thread.id)) return true;
  }
  return false;
}

async function drainQueuedTurns(threadId: string): Promise<void> {
  if (drainingQueues.has(threadId)) return;
  drainingQueues.add(threadId);
  try { await serializeTurnOperation(threadId, () => drainQueuedTurnsLocked(threadId)); }
  finally { drainingQueues.delete(threadId); }
}
async function drainQueuedTurnsLocked(threadId: string): Promise<void> {
  const queue = queuedTurns.get(threadId);
  const thread = knownThreads.get(threadId);
  if (!queue?.length || !thread) return;
  const activity = await activityTracker.inspect(thread);
  if (isTurnActiveStatus(activity.status) || activeCompactions.has(threadId)) return;
  try {
    if (!(await takeControl(thread))) return;
    const next = queue[0];
    if (!next) return;
    await codex.startTurn(
      threadId,
      { text: next.text, attachments: next.attachments },
      { model: next.model, effort: next.effort, serviceTier: next.serviceTier, mode: next.mode },
    );
    queueState(threadId);
    queue.shift();
    if (queue.length === 0) queuedTurns.delete(threadId);
    else queuedTurns.set(threadId, queue);
    broadcast(
      {
        type: "turn_dequeued",
        threadId,
        queuedId: next.id,
        queueLength: queue.length,
      },
      threadId,
    );
  } catch (error) {
    broadcast(
      {
        type: "error",
        error: {
          code: "queued_turn_failed",
          message:
            error instanceof Error
              ? error.message
              : "排队指令发送失败，后台会继续重试",
          retryable: true,
        },
      },
      threadId,
    );
  }
}

function pushEvent(event: ConsoleEvent): void {
  eventBuffer.push(event);
  while (eventBuffer.length > 2000) eventBuffer.shift();
  const isRequest = event.event.requestId !== undefined && (
    event.sourceMethod === "item/commandExecution/requestApproval" ||
    event.sourceMethod === "item/fileChange/requestApproval" ||
    event.sourceMethod === "item/tool/requestUserInput" ||
    event.sourceMethod === "item/permissions/requestApproval" ||
    event.sourceMethod === "mcpServer/elicitation/request" ||
    event.sourceMethod === "item/tool/call"
  );
  const payload = isRequest
    ? JSON.stringify({ type: "server_request", eventId: event.eventId, threadId: event.threadId, request: codex.getPendingRequests(event.threadId ?? "").find((request) => request.id === event.event.requestId) })
    : JSON.stringify({ type: "thread_event", eventId: event.eventId, threadId: event.threadId, event: { method: event.sourceMethod, params: event.event, receivedAt: event.receivedAt } });
  for (const socket of sockets) {
    // A mobile client subscribes to one thread. Sending every other thread's
    // delta can saturate a slow connection while another session is active.
    if (event.threadId && subscriptions.get(socket) !== event.threadId) continue;
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function updateSnapshot(event: ConsoleEvent): void {
  if (event.sourceMethod === "server/exit") activeCompactions.clear();
  if (!event.threadId) return;
  if (event.sourceMethod === "thread/goal/updated" || event.sourceMethod === "thread/goal/cleared") {
    const previous = goalStates.get(event.threadId);
    try {
      const goal = event.sourceMethod === "thread/goal/cleared" ? null : goalFromRaw(event.event.goal, event.threadId);
      goalStates.set(event.threadId, { ...previous, goal, supported: true, canControl: codex.controlsThread(event.threadId) });
    } catch { daemon.log.warn("忽略无效的 Codex 目标通知"); }
  }
  const snapshot = snapshots.get(event.threadId);
  if (!snapshot) return;
  const params = event.event;
  const method = event.sourceMethod;
  if (method === "thread/settings/updated") snapshot.thread.runtimeSettings = runtimeSettingsFromRaw(params.threadSettings);
  if (method === "model/rerouted") snapshot.thread.runtimeSettings = { ...snapshot.thread.runtimeSettings, model: typeof params.toModel === "string" ? params.toModel : undefined, reroutedFrom: typeof params.fromModel === "string" ? params.fromModel : undefined, rerouteReason: typeof params.reason === "string" ? params.reason : undefined };
  if (method === "thread/name/updated" && typeof params.threadName === "string") { snapshot.thread.title = params.threadName; const thread = knownThreads.get(event.threadId); if (thread) thread.title = params.threadName; }
  if (method === "thread/compacted") { snapshot.compaction = "completed"; activeCompactions.delete(event.threadId); }
  const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : undefined;
  if ((method === "turn/completed" || method === "turn/interrupted") && turnId && snapshot.thread.activeTurnId && turnId !== snapshot.thread.activeTurnId) return;
  if (method === "error" || method === "thread/realtime/error") {
    const message = errorTextFromRaw(params.error ?? params.message ?? params.additionalDetails);
    if (!snapshot.items.some((item) => item.kind === "system" && item.text === message)) {
      snapshot.items.push({ id: `codex-error-${String(params.turnId ?? randomUUID())}`, kind: "system", title: "Codex 错误", text: message, status: "failed" });
    }
    if (params.willRetry !== true) {
      if (activeCompactions.delete(event.threadId)) snapshot.compaction = "failed";
      snapshot.thread.status = "failed";
      snapshot.thread.activeTurnId = undefined;
      snapshot.thread.canInterrupt = false;
    }
  } else if (method === "item/agentMessage/delta") {
    const itemId = String(params.itemId ?? params.id ?? "streaming-agent");
    let item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, kind: "agent", text: "" }; snapshot.items.push(item); }
    item.text = `${item.text ?? ""}${String(params.delta ?? params.text ?? "")}`;
  } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    const itemId = String(params.itemId ?? params.id ?? "streaming-reasoning");
    let item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, kind: "reasoning", title: "Reasoning", text: "" }; snapshot.items.push(item); }
    item.text = `${item.text ?? ""}${String(params.delta ?? params.text ?? "")}`;
  } else if (method === "item/plan/delta") {
    const itemId = String(params.itemId ?? params.id ?? "streaming-plan");
    let item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, kind: "plan", title: "Plan", text: "", status: "inProgress" }; snapshot.items.push(item); }
    item.text = `${item.text ?? ""}${String(params.delta ?? "")}`;
  } else if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta") {
    const itemId = String(params.itemId ?? params.id ?? "streaming-command");
    let item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, kind: "command", title: "Command", output: "" }; snapshot.items.push(item); }
    item.output = `${item.output ?? ""}${String(params.delta ?? params.output ?? "")}`;
  } else if (method === "item/fileChange/outputDelta") {
    const itemId = String(params.itemId ?? params.id ?? "streaming-file-change");
    let item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) { item = { id: itemId, kind: "file_change", title: "File change", diff: "", status: "inProgress" }; snapshot.items.push(item); }
    item.diff = `${item.diff ?? ""}${String(params.delta ?? "")}`;
  } else if ((method === "item/started" || method === "item/completed") && params.item && typeof params.item === "object") {
    const mapped = itemFromRaw(params.item, event.receivedAt);
    if (mapped.kind === "compaction") { mapped.status = method === "item/completed" ? "completed" : "inProgress"; mapped.text = method === "item/completed" ? "上下文压缩完成" : "正在压缩上下文"; snapshot.compaction = method === "item/completed" ? "completed" : "running"; if (method === "item/completed") activeCompactions.delete(event.threadId); else activeCompactions.add(event.threadId); }
    const index = snapshot.items.findIndex((candidate) => candidate.id === mapped.id);
    if (index >= 0) snapshot.items[index] = { ...snapshot.items[index], ...mapped };
    else snapshot.items.push(mapped);
    if (mapped.kind === "file_change") {
      const changes = Array.isArray(mapped.metadata?.changes) ? mapped.metadata.changes.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
      snapshot.changedFiles ??= [];
      for (const change of changes) {
        if (typeof change.path !== "string") continue;
        const existing = snapshot.changedFiles.find((entry) => entry.path === change.path);
        const kind = change.kind && typeof change.kind === "object" ? change.kind as Record<string, unknown> : undefined;
        const status = typeof change.kind === "string" ? change.kind : typeof kind?.type === "string" ? kind.type : mapped.status ?? "modified";
        if (existing) existing.status = status; else snapshot.changedFiles.push({ path: change.path, status });
      }
      if (mapped.diff) snapshot.diff = mapped.diff;
    }
  } else if (method === "turn/completed") {
    const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : undefined;
    const terminalStatus = typeof turn?.status === "string" ? turn.status : typeof params.status === "string" ? params.status : "completed";
    if ((terminalStatus === "failed" || terminalStatus === "systemError") && turn?.error) {
      const message = errorTextFromRaw(turn.error);
      if (!snapshot.items.some((item) => item.kind === "system" && item.text === message)) {
        snapshot.items.push({ id: `codex-error-${String(turn.id ?? randomUUID())}`, kind: "system", title: "Codex 错误", text: message, status: "failed" });
      }
    }
    snapshot.thread.status = terminalStatus === "interrupted" ? "interrupted" : terminalStatus === "failed" || terminalStatus === "systemError" ? "failed" : "completed";
    if (snapshot.compaction === "running") snapshot.compaction = terminalStatus === "completed" ? "completed" : "failed";
    activeCompactions.delete(event.threadId);
    snapshot.thread.activeTurnId = undefined;
    snapshot.thread.canInterrupt = false;
    const lastAgent = [...snapshot.items].reverse().find((item) => item.kind === "agent");
    if (terminalStatus === "completed" && lastAgent && !lastAgent.status) lastAgent.status = "final_answer";
  } else if (method === "turn/started") {
    snapshot.thread.status = "running";
    snapshot.thread.activeTurnId = turnId;
    snapshot.thread.canInterrupt = true;
    snapshot.thread.activitySource = "console";
  } else if (method === "thread/status/changed") {
    const status = statusFromRaw(params.status);
    if (!(status === "idle" && snapshot.thread.activeTurnId)) snapshot.thread.status = status;
  } else if (method === "turn/diff/updated") {
    snapshot.diff = typeof params.diff === "string" ? params.diff : snapshot.diff;
  } else if (method === "turn/plan/updated") {
    const plan = params.plan;
    snapshot.plan = planFromRaw(plan);
  } else if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage;
    snapshot.tokenUsage = tokenUsageFromRaw(usage) ?? snapshot.tokenUsage;
  }
}

codex.onEvent((event) => { updateSnapshot(event); pushEvent(event); });

async function refreshThreadActivities(): Promise<void> {
  for (const thread of knownThreads.values()) {
    const activity = await activityTracker.inspect(thread);
    const previous = lastActivities.get(thread.id);
    const changed = !previous || previous.status !== activity.status || previous.activeTurnId !== activity.activeTurnId || previous.canInterrupt !== activity.canInterrupt || previous.activitySource !== activity.activitySource;
    lastActivities.set(thread.id, activity);
    thread.status = activity.status;
    thread.activeTurnId = activity.activeTurnId;
    thread.canInterrupt = activity.canInterrupt;
    thread.canRetry = !isTurnActiveStatus(activity.status) && codex.controlsThread(thread.id);
    thread.activitySource = activity.activitySource;
    const snapshot = snapshots.get(thread.id);
    if (snapshot) snapshot.thread = { ...snapshot.thread, ...thread };
    if (changed) broadcast({ type: "thread_activity", activity }, undefined);

    const isObservedExternalRun = activity.status === "running" && activity.activitySource === "external" && [...subscriptions.values()].includes(thread.id);
    const justFinishedExternalRun = changed && previous?.status === "running" && activity.status !== "running" && [...subscriptions.values()].includes(thread.id);
    if (isObservedExternalRun || justFinishedExternalRun) {
      try {
        const fresh = await codex.readThread(thread.id);
        fresh.thread = { ...fresh.thread, ...thread };
        snapshots.set(thread.id, fresh);
        broadcast({ type: "thread_snapshot", eventId: randomUUID(), snapshot: publicSnapshot(fresh) }, thread.id);
      } catch {
        // The rollout activity remains authoritative while another process owns the writer lock.
      }
    }
    if (!isTurnActiveStatus(activity.status) && queuedTurns.get(thread.id)?.length) {
      void drainQueuedTurns(thread.id);
    }
  }
}

function scheduleThreadActivityRefresh(): void {
  if (refreshingActivities) return;
  refreshingActivities = refreshThreadActivities().finally(() => {
    refreshingActivities = null;
  });
}

const textExtensions = new Set([".txt", ".md", ".mdx", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".csv", ".tsv", ".log", ".xml", ".html", ".css", ".scss", ".less", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".hpp", ".sh", ".bash", ".zsh", ".fish", ".sql", ".tex", ".bib", ".vue", ".svelte", ".env", ".gitignore"]);
const mimeTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
};

function fileKind(filePath: string): "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary" {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".mdx") return "markdown";
  if (mimeTypes[extension]?.startsWith("image/")) return "image";
  if (mimeTypes[extension]?.startsWith("video/")) return "video";
  if (mimeTypes[extension]?.startsWith("audio/")) return "audio";
  if (extension === ".pdf") return "pdf";
  if (textExtensions.has(extension) || !extension) return "text";
  return "binary";
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: processStdin, output: process.stdout });
    const value = await rl.question("设置登录密码（至少 12 个字符）: ");
    rl.close();
    return value;
  }
  return new Promise((resolve) => { let value = ""; processStdin.setEncoding("utf8"); processStdin.on("data", (chunk) => { value += chunk; }); processStdin.on("end", () => resolve(value.trim())); });
}

async function runCli(): Promise<boolean> {
  const command = process.argv[2];
  if (command !== "password") return false;
  await loadState();
  const action = process.argv[3] ?? "set";
  if (action !== "set" && action !== "change") throw new Error("用法: npm run start -- password set|change");
  const password = process.argv[4] ?? await readPasswordFromStdin();
  await setPassword(password);
  console.log("密码已保存。启动服务后使用该密码登录。");
  return true;
}

async function buildServer(): Promise<void> {
  await loadState();
  await daemon.register(cookie);
  await daemon.register(websocket);
  daemon.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  const activityTimer = setInterval(scheduleThreadActivityRefresh, 1200);
  activityTimer.unref();
  daemon.addHook("onClose", async () => {
    clearInterval(activityTimer);
    for (const controller of runningCommands.values()) controller.abort();
    runningCommands.clear();
  });
  daemon.get("/api/healthz", async (request) => ok(request, { ok: true, daemonVersion: "0.1.0", buildRevision: process.env.CODEX_CONSOLE_BUILD_REVISION, codexVersion: codex.version, appServer: codex.version === "unknown" ? "starting" : "ready", activeThreads: [...lastActivities.values()].filter((activity) => isTurnActiveStatus(activity.status)).length, activeCommands: runningCommands.size, queuedTurns: [...queuedTurns.values()].reduce((total, queue) => total + queue.length, 0), pendingRequests: [...snapshots.keys()].reduce((total, threadId) => total + codex.getPendingRequests(threadId).length, 0), turnOperations: turnOperations.size + activeCompactions.size, loadedThreads: snapshots.size, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
  daemon.post<{ Body: { password?: string } }>("/api/auth/login", async (request, reply) => { await login(request, reply, typeof request.body?.password === "string" ? request.body.password : ""); return; });
  daemon.post("/api/auth/logout", async (request, reply) => { if (!(await requireAuth(request, reply))) return; await logout(request, reply); });
  daemon.get("/api/auth/me", async (request, reply) => { if (!(await requireAuth(request, reply))) return; return ok(request, { authenticated: true, passwordConfigured: Boolean(getState().passwordHash), codexVersion: codex.version }); });
  daemon.get("/api/models", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      cachedOfficialModels = await codex.listModels();
      return ok(request, mergeModels(cachedOfficialModels));
    } catch (error) {
      const customModels = mergeModels([]);
      if (customModels.length > 0) return ok(request, customModels);
      return reply.code(503).send(
        failure(
          request,
          "models_unavailable",
          error instanceof Error ? error.message : "无法读取模型列表",
          true,
        ),
      );
    }
  });
  daemon.post<{ Body: { model?: string; displayName?: string } }>("/api/models/custom", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({
      model: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/, "模型名只能包含字母、数字、点、横线、下划线、斜线、冒号、@ 和加号"),
      displayName: z.string().trim().max(160).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "显示名称不能包含控制字符").optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_model", parsed.error.issues[0]?.message ?? "模型名无效"));
    const models = getCustomModels();
    if (models.some((entry) => entry.model === parsed.data.model)) {
      return reply.code(409).send(failure(request, "model_exists", "该自定义模型已经存在"));
    }
    if (cachedOfficialModels.some((entry) => entry.model === parsed.data.model)) {
      return reply.code(409).send(failure(request, "model_exists", "该模型已经由 Codex 提供，无需重复添加"));
    }
    const entry = { model: parsed.data.model, displayName: parsed.data.displayName || parsed.data.model };
    await setCustomModels([...models, entry]);
    return reply.code(201).send(ok(request, customModelOption(entry.model, entry.displayName)));
  });
  daemon.delete<{ Body: { model?: string } }>("/api/models/custom", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({ model: z.string().trim().min(1).max(160) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_model", "模型名无效"));
    const models = getCustomModels();
    const next = models.filter((entry) => entry.model !== parsed.data.model);
    if (next.length === models.length) return reply.code(404).send(failure(request, "model_not_found", "没有找到该自定义模型"));
    await setCustomModels(next);
    return ok(request, null);
  });

  daemon.post<{
    Querystring: { name?: string; mime?: string };
    Body: Buffer;
  }>("/api/uploads", { bodyLimit: maxUploadBytes }, async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send(failure(request, "empty_upload", "上传文件不能为空"));
    }
    if (body.length > maxUploadBytes) {
      return reply.code(413).send(failure(request, "upload_too_large", "单个附件不能超过 25 MiB"));
    }
    const originalName = path.basename(request.query.name?.trim() || "attachment").slice(0, 180);
    const mime = request.query.mime?.slice(0, 160) || "application/octet-stream";
    const rawExtension = path.extname(originalName).toLowerCase();
    const extension = /^\.[a-z0-9]{1,12}$/.test(rawExtension) ? rawExtension : "";
    const directory = path.join(uploadRoot, new Date().toISOString().slice(0, 10));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const storedPath = path.join(directory, `${id}${extension}`);
    await writeFile(storedPath, body, { mode: 0o600, flag: "wx" });
    return reply.code(201).send(ok(request, {
      id,
      name: originalName,
      path: storedPath,
      mime,
      size: body.length,
      kind: uploadKind(mime),
    }));
  });

  daemon.post<{
    Querystring: { path?: string; name?: string; mime?: string };
    Body: Buffer;
  }>("/api/fs/upload", { bodyLimit: maxUploadBytes }, async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send(failure(request, "empty_upload", "上传文件不能为空"));
    }
    if (body.length > maxUploadBytes) {
      return reply.code(413).send(failure(request, "upload_too_large", "单个文件不能超过 25 MiB"));
    }
    const rawName = request.query.name?.trim() ?? "";
    const name = path.basename(rawName).slice(0, 180);
    if (
      !rawName ||
      rawName !== name ||
      name === "." ||
      name === ".." ||
      /[\\/\u0000-\u001f\u007f]/.test(name)
    ) {
      return reply.code(400).send(failure(request, "invalid_upload_name", "文件名不能包含路径分隔符或控制字符"));
    }
    try {
      const directory = await resolveServerDirectory(request.query.path || config.codexCwd, config.codexCwd);
      const storedPath = path.join(directory, name);
      await writeFile(storedPath, body, { mode: 0o600, flag: "wx" });
      const canonicalPath = await resolveServerPath(storedPath, directory);
      const metadata = await stat(canonicalPath);
      return reply.code(201).send(ok(request, {
        name,
        path: canonicalPath,
        type: "file",
        kind: fileKind(canonicalPath),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        hidden: name.startsWith("."),
      }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return reply.code(409).send(failure(request, "file_exists", "同名文件已经存在"));
      return reply.code(400).send(failure(request, "upload_failed", error instanceof Error ? error.message : "无法上传文件"));
    }
  });

  daemon.get("/api/projects", async (request, reply) => { if (!(await requireAuth(request, reply))) return; return ok(request, getState().projects); });
  daemon.post<{ Body: { name?: string; path?: string } }>("/api/projects", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({ name: z.string().min(1).max(80), path: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_input", "项目名称和路径不能为空"));
    try {
      const canonicalPath = await resolveServerDirectory(parsed.data.path, config.codexCwd);
      const project = { id: crypto.randomUUID(), name: parsed.data.name, canonicalPath, enabled: true };
      getState().projects.push(project); await persistState(); return reply.code(201).send(ok(request, project));
    } catch (error) { return reply.code(400).send(failure(request, "invalid_path", error instanceof Error ? error.message : "项目路径无效")); }
  });

  daemon.get<{ Querystring: { path?: string } }>("/api/fs/list", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      const directory = await resolveServerDirectory(request.query.path || config.codexCwd, config.codexCwd);
      const dirents = await readdir(directory, { withFileTypes: true });
      const entries = await Promise.all(dirents.slice(0, 1000).map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        try {
          const resolved = await resolveServerPath(entryPath, directory);
          const metadata = await stat(resolved);
          return { name: entry.name, path: resolved, type: metadata.isDirectory() ? "directory" : "file", kind: metadata.isDirectory() ? "directory" : fileKind(resolved), size: metadata.size, modifiedAt: metadata.mtime.toISOString(), hidden: entry.name.startsWith(".") };
        } catch { return null; }
      }));
      const visible = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
      const root = path.parse(directory).root;
      return ok(request, { path: directory, root, parent: directory === root ? null : path.dirname(directory), entries: visible, truncated: dirents.length > 1000 });
    } catch (error) { return reply.code(400).send(failure(request, "invalid_path", error instanceof Error ? error.message : "无法读取目录")); }
  });

  daemon.post<{ Body: { parent?: string; name?: string } }>("/api/fs/directories", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({
      parent: z.string().min(1),
      name: z.string().trim().min(1).max(120).refine(
        (name) => name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name),
        "文件夹名称不能包含路径分隔符或控制字符",
      ),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_directory_name", parsed.error.issues[0]?.message ?? "文件夹名称无效"));
    try {
      const parent = await resolveServerDirectory(parsed.data.parent, config.codexCwd);
      const directory = path.join(parent, parsed.data.name);
      await mkdir(directory, { mode: 0o700 });
      const canonicalPath = await resolveServerDirectory(directory, config.codexCwd);
      return reply.code(201).send(ok(request, { name: parsed.data.name, path: canonicalPath, parent }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return reply.code(409).send(failure(request, "directory_exists", "同名文件或文件夹已经存在"));
      return reply.code(400).send(failure(request, "create_directory_failed", error instanceof Error ? error.message : "无法创建文件夹"));
    }
  });

  daemon.get<{ Querystring: { path?: string } }>("/api/fs/server-directories", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      const directory = await resolveServerDirectory(request.query.path || config.codexCwd, config.codexCwd);
      const dirents = await readdir(directory, { withFileTypes: true });
      const entries = await Promise.all(dirents.slice(0, 1000).map(async (entry) => {
        try {
          const resolved = await resolveServerDirectory(path.join(directory, entry.name), directory);
          const metadata = await stat(resolved);
          return {
            name: entry.name,
            path: resolved,
            type: "directory" as const,
            kind: "directory" as const,
            size: metadata.size,
            modifiedAt: metadata.mtime.toISOString(),
            hidden: entry.name.startsWith("."),
          };
        } catch {
          return null;
        }
      }));
      const visible = entries
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .sort((left, right) => left.name.localeCompare(right.name));
      const root = path.parse(directory).root;
      return ok(request, {
        path: directory,
        root,
        parent: directory === root ? null : path.dirname(directory),
        entries: visible,
        truncated: dirents.length > 1000,
      });
    } catch (error) {
      return reply.code(400).send(failure(request, "invalid_path", error instanceof Error ? error.message : "无法读取服务器目录"));
    }
  });

  daemon.post<{ Body: { parent?: string; name?: string } }>("/api/fs/server-directories", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({
      parent: z.string().min(1),
      name: z.string().trim().min(1).max(120).refine(
        (name) => name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name),
        "文件夹名称不能包含路径分隔符或控制字符",
      ),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_directory_name", parsed.error.issues[0]?.message ?? "文件夹名称无效"));
    try {
      const parent = await resolveServerDirectory(parsed.data.parent, config.codexCwd);
      const directory = path.join(parent, parsed.data.name);
      await mkdir(directory, { mode: 0o700 });
      const canonicalPath = await resolveServerDirectory(directory, config.codexCwd);
      return reply.code(201).send(ok(request, { name: parsed.data.name, path: canonicalPath, parent }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return reply.code(409).send(failure(request, "directory_exists", "同名文件或文件夹已经存在"));
      return reply.code(400).send(failure(request, "create_directory_failed", error instanceof Error ? error.message : "无法创建文件夹"));
    }
  });

  daemon.get<{ Querystring: { path?: string } }>("/api/fs/content", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      if (!request.query.path) return reply.code(400).send(failure(request, "missing_path", "缺少文件路径"));
      const filePath = await resolveServerPath(request.query.path, config.codexCwd);
      const metadata = await stat(filePath);
      if (!metadata.isFile()) return reply.code(400).send(failure(request, "not_file", "所选路径不是文件"));
      const kind = fileKind(filePath);
      if (kind !== "text" && kind !== "markdown") return reply.code(415).send(failure(request, "binary_file", "该文件需要使用媒体预览"));
      if (metadata.size > 5 * 1024 * 1024) return reply.code(413).send(failure(request, "file_too_large", "文本文件超过 5 MiB，请下载后查看"));
      const content = await readFile(filePath, "utf8");
      return ok(request, { path: filePath, name: path.basename(filePath), kind, size: metadata.size, modifiedAt: metadata.mtime.toISOString(), content });
    } catch (error) { return reply.code(400).send(failure(request, "read_failed", error instanceof Error ? error.message : "无法读取文件")); }
  });

  daemon.get<{ Querystring: { path?: string } }>("/api/fs/raw", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      if (!request.query.path) return reply.code(400).send(failure(request, "missing_path", "缺少文件路径"));
      const filePath = await resolveServerPath(request.query.path, config.codexCwd);
      const metadata = await stat(filePath);
      if (!metadata.isFile()) return reply.code(400).send(failure(request, "not_file", "所选路径不是文件"));
      const contentType = mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      reply.header("Content-Type", contentType).header("Accept-Ranges", "bytes").header("Cache-Control", "private, no-store").header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return reply.code(416).header("Content-Range", `bytes */${metadata.size}`).send();
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= metadata.size) return reply.code(416).header("Content-Range", `bytes */${metadata.size}`).send();
        reply.code(206).header("Content-Range", `bytes ${start}-${end}/${metadata.size}`).header("Content-Length", String(end - start + 1));
        return reply.send(createReadStream(filePath, { start, end }));
      }
      reply.header("Content-Length", String(metadata.size));
      return reply.send(createReadStream(filePath));
    } catch (error) { return reply.code(404).send(failure(request, "read_failed", error instanceof Error ? error.message : "无法读取文件")); }
  });

  daemon.post<{ Body: { cwd?: string; command?: string; commandId?: string } }>("/api/commands", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({
      cwd: z.string().min(1),
      command: z.string().trim().min(1).max(16_000),
      commandId: z.string().uuid().optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_command", "当前路径、命令和命令 ID 必须有效"));
    if (runningCommands.size >= 2) return reply.code(429).send(failure(request, "command_busy", "已有太多命令正在执行，请稍后重试", true));
    const commandId = parsed.data.commandId ?? randomUUID();
    if (runningCommands.has(commandId)) return reply.code(409).send(failure(request, "command_exists", "该命令已经在运行"));
    const controller = new AbortController();
    runningCommands.set(commandId, controller);
    try {
      const cwd = await resolveServerDirectory(parsed.data.cwd, config.codexCwd);
      const result = await runWorkspaceCommand({ command: parsed.data.command, cwd, shell: config.shellCommand, signal: controller.signal });
      return ok(request, { ...result, commandId });
    } catch (error) {
      return reply.code(400).send(failure(request, "command_failed", error instanceof Error ? error.message : "命令执行失败"));
    } finally {
      runningCommands.delete(commandId);
    }
  });
  daemon.delete<{ Params: { commandId: string } }>("/api/commands/:commandId", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const controller = runningCommands.get(request.params.commandId);
    if (!controller) return reply.code(404).send(failure(request, "command_not_found", "命令已经结束或不存在"));
    controller.abort();
    return ok(request, null);
  });

  daemon.get<{ Querystring: { cwd?: string; cursor?: string; archived?: string; search?: string; page?: string } }>("/api/threads", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      const page = await codex.listThreadPage({ cwd: request.query.cwd, cursor: request.query.cursor, archived: request.query.archived === "true", searchTerm: request.query.search?.slice(0, 200) });
      const threads = await Promise.all(page.threads.map(async (thread) => { if (request.query.archived === "true") archivedIds.add(thread.id); else archivedIds.delete(thread.id); knownThreads.set(thread.id, thread); const result = await activityTracker.enrich(thread); result.canRetry = !isTurnActiveStatus(result.status) && codex.controlsThread(result.id); knownThreads.set(result.id, result); return publicThread(result); }));
      return ok(request, request.query.page === "true" ? { threads, nextCursor: page.nextCursor } : threads);
    } catch (error) { return reply.code(503).send(failure(request, "codex_unavailable", error instanceof Error ? error.message : "Codex 不可用", true)); }
  });
  daemon.get<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      const snapshot = await codex.readThread(request.params.threadId);
      snapshot.compaction = snapshots.get(snapshot.thread.id)?.compaction;
      snapshot.tokenUsage = snapshots.get(snapshot.thread.id)?.tokenUsage ?? snapshot.tokenUsage;
      snapshot.thread = await activityTracker.enrich(snapshot.thread);
      if (!isTurnActiveStatus(snapshot.thread.status) && !archivedIds.has(snapshot.thread.id)) {
        await codex.tryTakeControl(snapshot.thread.id);
        snapshot.thread.runtimeSettings = codex.runtimeSettings(snapshot.thread.id) ?? snapshot.thread.runtimeSettings;
      }
      snapshot.thread.canRetry = !archivedIds.has(snapshot.thread.id) && !isTurnActiveStatus(snapshot.thread.status) && codex.controlsThread(snapshot.thread.id);
      knownThreads.set(snapshot.thread.id, snapshot.thread); snapshots.set(snapshot.thread.id, snapshot);
      return ok(request, publicSnapshot(snapshot));
    } catch (error) { return reply.code(404).send(failure(request, "thread_not_found", error instanceof Error ? error.message : "线程不存在")); }
  });
  daemon.post<{ Body: { cwd?: string; model?: string; sandbox?: string; approvalPolicy?: string } }>("/api/threads", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({
      cwd: z.string().trim().min(1).optional(),
      model: z.string().optional(),
      sandbox: z.string().optional(),
      approvalPolicy: z.string().optional(),
    }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_thread", "线程工作目录和设置必须有效"));
    let cwd: string | undefined;
    try {
      cwd = parsed.data.cwd
        ? await resolveServerDirectory(parsed.data.cwd, config.codexCwd)
        : undefined;
    } catch (error) {
      return reply.code(400).send(failure(request, "invalid_path", error instanceof Error ? error.message : "线程工作目录无效"));
    }
    try {
      const snapshot = await codex.startThread({ ...parsed.data, cwd });
      snapshot.thread.canRetry = true;
      knownThreads.set(snapshot.thread.id, snapshot.thread);
      snapshots.set(snapshot.thread.id, snapshot);
      return reply.code(201).send(ok(request, publicSnapshot(snapshot)));
    } catch (error) {
      return reply.code(503).send(failure(request, "codex_unavailable", error instanceof Error ? error.message : "无法创建线程", true));
    }
  });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/resume", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { const snapshot = await codex.resumeThread(request.params.threadId); snapshot.thread.canRetry = true; knownThreads.set(snapshot.thread.id, snapshot.thread); snapshots.set(snapshot.thread.id, snapshot); return ok(request, publicSnapshot(snapshot)); } catch (error) { return reply.code(503).send(failure(request, "resume_failed", error instanceof Error ? error.message : "无法恢复线程", true)); } });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/archive", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try { await serializeTurnOperation(request.params.threadId, async () => {
      const thread = knownThreads.get(request.params.threadId) ?? summaryFromRaw((await codex.request("thread/read", { threadId: request.params.threadId, includeTurns: false }) as { thread: unknown }).thread);
      if ((thread && isTurnActiveStatus((await activityTracker.inspect(thread)).status)) || queuedTurns.get(request.params.threadId)?.length || activeCompactions.has(request.params.threadId)) throw new Error("请先结束活动任务并处理排队指令，再归档线程");
      await codex.archiveThread(request.params.threadId); snapshots.delete(request.params.threadId); knownThreads.delete(request.params.threadId); lastActivities.delete(request.params.threadId);
      archivedIds.add(request.params.threadId);
    }); return ok(request, null); } catch (error) { return reply.code(409).send(failure(request, "archive_failed", error instanceof Error ? error.message : "无法归档线程", true)); }
  });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/unarchive", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { await serializeTurnOperation(request.params.threadId, async () => { await codex.unarchiveThread(request.params.threadId); archivedIds.delete(request.params.threadId); }); return ok(request, null); } catch (error) { return reply.code(503).send(failure(request, "unarchive_failed", error instanceof Error ? error.message : "无法恢复线程", true)); } });

  daemon.patch<{ Params: { threadId: string } }>("/api/threads/:threadId/name", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({ name: z.string().trim().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_name", "名称必须为 1–200 个字符"));
    try { await serializeTurnOperation(request.params.threadId, async () => { await codex.request("thread/name/set", { threadId: request.params.threadId, name: parsed.data.name }); const thread = knownThreads.get(request.params.threadId); if (thread) thread.title = parsed.data.name; const snapshot = snapshots.get(request.params.threadId); if (snapshot) snapshot.thread.title = parsed.data.name; }); return ok(request, null); }
    catch (error) { return reply.code(409).send(failure(request, "rename_failed", error instanceof Error ? error.message : "重命名失败")); }
  });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/fork", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.object({ lastTurnId: z.string().min(1).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_fork", "分支设置无效"));
    try { let snapshot: ThreadSnapshot | undefined; await serializeTurnOperation(request.params.threadId, async () => { const thread = knownThreads.get(request.params.threadId) ?? summaryFromRaw((await codex.request("thread/read", { threadId: request.params.threadId, includeTurns: false }) as { thread: unknown }).thread); if (activeCompactions.has(request.params.threadId) || (thread && isTurnActiveStatus((await activityTracker.inspect(thread)).status))) throw new Error("请先结束当前任务，再创建分支"); snapshot = await codex.forkThread(request.params.threadId, parsed.data.lastTurnId); knownThreads.set(snapshot.thread.id, snapshot.thread); snapshots.set(snapshot.thread.id, snapshot); }); return ok(request, publicSnapshot(snapshot!)); }
    catch (error) { return reply.code(409).send(failure(request, "fork_failed", error instanceof Error ? error.message : "无法创建分支")); }
  });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/compact", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try { await serializeTurnOperation(request.params.threadId, async () => { const snapshot = snapshots.get(request.params.threadId); if (!snapshot) throw new Error("请先打开线程"); if (isTurnActiveStatus((await activityTracker.inspect(snapshot.thread)).status) || activeCompactions.has(request.params.threadId) || queuedTurns.get(request.params.threadId)?.length || archivedIds.has(request.params.threadId)) throw new Error("请等当前任务及排队指令结束后压缩上下文"); if (!(await codex.tryTakeControl(request.params.threadId))) throw new Error("外部 Codex 持有此线程，无法压缩"); snapshot.compaction = "running"; activeCompactions.add(request.params.threadId); try { await codex.request("thread/compact/start", { threadId: request.params.threadId }); } catch (error) { snapshot.compaction = "failed"; activeCompactions.delete(request.params.threadId); throw error; } broadcast({ type: "thread_snapshot", snapshot: publicSnapshot(snapshot) }, request.params.threadId); }); return ok(request, null); }
    catch (error) { return reply.code(409).send(failure(request, "compact_failed", error instanceof Error ? error.message : "压缩失败")); }
  });
  daemon.get<{ Params: { threadId: string } }>("/api/threads/:threadId/queue", async (request, reply) => { if (!(await requireAuth(request, reply))) return; return ok(request, queuedTurns.get(request.params.threadId) ?? []); });
  daemon.patch<{ Params: { threadId: string } }>("/api/threads/:threadId/queue", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = z.discriminatedUnion("action", [z.object({ action: z.literal("delete"), id: z.string() }), z.object({ action: z.literal("edit"), id: z.string(), text: z.string().trim().max(100000) }), z.object({ action: z.literal("reorder"), ids: z.array(z.string()).max(1000) })]).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_queue", "排队操作无效"));
    try { await serializeTurnOperation(request.params.threadId, async () => {
      const queue = queuedTurns.get(request.params.threadId) ?? []; const input = parsed.data;
      if (input.action === "reorder") {
        if (input.ids.length !== queue.length || new Set(input.ids).size !== queue.length || input.ids.some((id) => !queue.some((entry) => entry.id === id))) throw new Error("队列已变化，请刷新后重试");
        queuedTurns.set(request.params.threadId, input.ids.map((id) => queue.find((entry) => entry.id === id)!));
      } else { const index = queue.findIndex((entry) => entry.id === input.id); const entry = queue[index]; if (!entry) throw new Error("该指令已开始执行或取消"); if (input.action === "delete") queue.splice(index, 1); else { if (!input.text && !entry.attachments.length) throw new Error("消息不能为空"); entry.text = input.text; } }
      queueState(request.params.threadId);
    }); return ok(request, queuedTurns.get(request.params.threadId) ?? []); }
    catch (error) { return reply.code(409).send(failure(request, "queue_changed", error instanceof Error ? error.message : "队列操作失败")); }
  });
  daemon.get<{ Querystring: { threadId?: string } }>("/api/runtime/status", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const thread = request.query.threadId ? knownThreads.get(request.query.threadId) : undefined;
    const cwd = thread?.cwd ?? config.codexCwd;
    const unavailable = { available: false, error: "当前 Codex 版本、配置或模型提供商不提供此状态", entries: [] };
    const read = async (method: string, params: unknown, map: (raw: unknown) => unknown) => { try { return map(await codex.request(method, params, 12000)); } catch { return unavailable; } };
    const [quotas, mcp, skills, plugins, hooks] = await Promise.all([
      read("account/rateLimits/read", {}, quotasFromRaw),
      (async () => {
        try {
          const data: unknown[] = []; let cursor: string | null = null; const seen = new Set<string>();
          do { const page = await codex.request("mcpServerStatus/list", { ...(thread ? { threadId: thread.id } : {}), limit: 100, cursor }, 12000) as { data?: unknown[]; nextCursor?: string }; data.push(...(page.data ?? [])); cursor = page.nextCursor ?? null; if (cursor && seen.has(cursor)) throw new Error("Repeated MCP cursor"); if (cursor) seen.add(cursor); } while (cursor);
          return inventoryFromRaw("mcp", { data });
        } catch { return unavailable; }
      })(),
      read("skills/list", { cwds: [cwd] }, (raw) => inventoryFromRaw("skills", raw)),
      read("plugin/installed", { cwds: [cwd] }, (raw) => inventoryFromRaw("plugins", raw)),
      read("hooks/list", { cwds: [cwd] }, (raw) => inventoryFromRaw("hooks", raw)),
    ]);
    return ok(request, { quotas, mcp, skills, plugins, hooks } as RuntimeInventory);
  });

  daemon.get<{ Params: { threadId: string } }>("/api/threads/:threadId/goal", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try { return ok(request, await readGoalState(request.params.threadId)); }
    catch (error) {
      if (goalUnsupported(error)) return ok(request, { goal: null, supported: false, canControl: false, controlReason: "当前 Codex 版本或配置不支持目标模式" });
      return reply.code(503).send(failure(request, "goal_read_failed", error instanceof Error ? error.message : "无法读取目标", true));
    }
  });
  daemon.patch<{ Params: { threadId: string } }>("/api/threads/:threadId/goal", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    const parsed = goalUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure(request, "invalid_goal", parsed.error.issues[0]?.message ?? "目标设置无效"));
    try {
      let state: GoalState | undefined;
      await serializeTurnOperation(request.params.threadId, async () => {
        if (!(await codex.tryTakeControl(request.params.threadId))) throw new Error("当前线程被其他 Codex 窗口占用，无法修改目标。请先在原窗口暂停或退出，再重新打开线程。");
        const existing = await codex.getGoal(request.params.threadId);
        const update = existing ? parsed.data : { ...parsed.data, status: parsed.data.status ?? ("paused" as const) };
        const goal = await codex.setGoal(request.params.threadId, update);
        state = { goal, supported: true, canControl: true };
        goalStates.set(request.params.threadId, state);
        broadcast({ type: "goal_state", threadId: request.params.threadId, state }, request.params.threadId);
      });
      return ok(request, state);
    } catch (error) { return reply.code(409).send(failure(request, "goal_update_failed", error instanceof Error ? error.message : "无法修改目标", true)); }
  });
  daemon.delete<{ Params: { threadId: string } }>("/api/threads/:threadId/goal", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      const state: GoalState = { goal: null, supported: true, canControl: true };
      await serializeTurnOperation(request.params.threadId, async () => {
        if (!(await codex.tryTakeControl(request.params.threadId))) throw new Error("当前线程被其他 Codex 窗口占用，无法删除目标。请先在原窗口暂停或退出，再重新打开线程。");
        await codex.clearGoal(request.params.threadId);
        goalStates.set(request.params.threadId, state);
        broadcast({ type: "goal_state", threadId: request.params.threadId, state }, request.params.threadId);
      });
      return ok(request, state);
    } catch (error) { return reply.code(409).send(failure(request, "goal_delete_failed", error instanceof Error ? error.message : "无法删除目标", true)); }
  });

  daemon.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    void (async () => {
      if (!allowedOrigin(request.headers.origin)) { socket.close(4403, "Invalid origin"); return; }
      if (!(await authenticated(request))) { socket.close(4401, "Unauthenticated"); return; }
      sockets.add(socket);
      socket.send(JSON.stringify({ type: "server_ready", codexVersion: codex.version, capabilities: codex.capabilities }));
      socket.on("message", async (raw) => {
        let action: Record<string, unknown> = {};
        try {
          action = JSON.parse(String(raw)) as Record<string, unknown>;
          if (action.type === "subscribe_thread" && typeof action.threadId === "string") {
            subscriptions.set(socket, action.threadId);
            let snapshot = snapshots.get(action.threadId);
            if (!snapshot) {
              snapshot = await codex.readThread(action.threadId);
              snapshot.thread = await activityTracker.enrich(snapshot.thread);
              knownThreads.set(snapshot.thread.id, snapshot.thread);
              snapshots.set(action.threadId, snapshot);
            }
            socket.send(JSON.stringify({ type: "thread_snapshot", eventId: randomUUID(), snapshot: publicSnapshot(snapshot) }));
            const queue = queuedTurns.get(action.threadId) ?? [];
            socket.send(JSON.stringify({
              type: "turn_queue_state",
              threadId: action.threadId,
              queue,
            }));
            return;
          }
          if (action.type === "start_turn" && typeof action.threadId === "string" && (typeof action.text === "string" || Array.isArray(action.attachments))) {
            await serializeTurnOperation(action.threadId, async () => {
              const thread = knownThreads.get(action.threadId as string) ?? snapshots.get(action.threadId as string)?.thread;
              if (!thread) throw new Error("线程尚未加载");
              if (archivedIds.has(thread.id)) throw new Error("请先恢复归档线程，再发送消息");
              const input = await resolveTurnInput(action);
              const model = typeof action.model === "string" && action.model ? action.model : undefined;
              const settings = executionSettingsSchema.parse({ model, effort: action.effort, serviceTier: action.serviceTier, mode: action.mode });
              const activity = await activityTracker.inspect(thread);
              if (isTurnActiveStatus(activity.status) || activeCompactions.has(thread.id)) {
                queueTurn(action.threadId as string, input, settings);
                return;
              }
              if (!(await takeControl(thread))) {
                queueTurn(action.threadId as string, input, settings);
                return;
              }
              await codex.startTurn(action.threadId as string, input, settings);
            });
            return;
          }
          if (action.type === "steer_turn" && typeof action.threadId === "string" && typeof action.turnId === "string" && (typeof action.text === "string" || Array.isArray(action.attachments))) {
            await serializeTurnOperation(action.threadId, async () => {
              const input = await resolveTurnInput(action);
              if (codex.ownsTurn(action.threadId as string, action.turnId as string)) {
                await codex.steerTurn(action.threadId as string, action.turnId as string, input);
              } else {
                queueTurn(action.threadId as string, input, executionSettingsSchema.parse({ model: action.model, effort: action.effort, serviceTier: action.serviceTier, mode: action.mode }));
              }
            });
            return;
          }
          if (action.type === "queue_turn" && typeof action.threadId === "string" && (typeof action.text === "string" || Array.isArray(action.attachments))) {
            await serializeTurnOperation(action.threadId, async () => {
              if (!knownThreads.has(action.threadId as string) || archivedIds.has(action.threadId as string)) throw new Error("请先打开未归档的线程");
              const input = await resolveTurnInput(action);
              queueTurn(action.threadId as string, input, executionSettingsSchema.parse({ model: action.model, effort: action.effort, serviceTier: action.serviceTier, mode: action.mode }));
              void drainQueuedTurns(action.threadId as string);
            });
            return;
          }
          if (action.type === "interrupt_turn" && typeof action.threadId === "string") {
            await serializeTurnOperation(action.threadId, async () => {
              const ownedTurnId = codex.activeTurnId(action.threadId as string);
              if (ownedTurnId) {
                await codex.interruptTurn(action.threadId as string, ownedTurnId);
                return;
              }
              const thread = knownThreads.get(action.threadId as string) ?? snapshots.get(action.threadId as string)?.thread;
              const activity = thread
                ? await activityTracker.inspect(thread)
                : undefined;
              if (
                !thread ||
                !(await externalCodex.interrupt(
                  thread.rolloutPath,
                  activity?.status === "running" &&
                    activity.activitySource === "external",
                ))
              ) {
                throw new Error("没有找到拥有该 Turn 的活动 Codex 进程，状态可能刚刚发生变化");
              }
              broadcast(
                {
                  type: "interrupt_requested",
                  threadId: action.threadId,
                  turnId: typeof action.turnId === "string" ? action.turnId : undefined,
                },
                action.threadId as string,
              );
            });
            return;
          }
          if (action.type === "retry_last_turn" && typeof action.threadId === "string" && typeof action.text === "string" && action.text.trim()) {
            await serializeTurnOperation(action.threadId, async () => {
              if (activeCompactions.has(action.threadId as string) || queuedTurns.get(action.threadId as string)?.length) throw new Error("请先等待上下文压缩完成并处理排队指令，再回退重发");
              const activity = await activityTracker.inspect(knownThreads.get(action.threadId as string) ?? snapshots.get(action.threadId as string)?.thread ?? { id: action.threadId as string, title: "", status: "unknown" });
              if (isTurnActiveStatus(activity.status)) throw new Error("请先中止当前运行，再编辑并重新发送最近消息");
              const input = await resolveTurnInput(action);
              const rolledBack = await codex.rollbackLastTurn(action.threadId as string);
              rolledBack.thread.canRetry = true;
              knownThreads.set(rolledBack.thread.id, rolledBack.thread);
              snapshots.set(rolledBack.thread.id, rolledBack);
              const replaced = rolledBack.thread.id !== action.threadId;
              broadcast({ type: "thread_snapshot", eventId: randomUUID(), snapshot: publicSnapshot(rolledBack), replacesThreadId: replaced ? action.threadId : undefined }, action.threadId as string);
              if (replaced) {
                for (const [client, threadId] of subscriptions) if (threadId === action.threadId) subscriptions.set(client, rolledBack.thread.id);
              }
              try {
                await codex.startTurn(rolledBack.thread.id, input, executionSettingsSchema.parse({ model: action.model, effort: action.effort, serviceTier: action.serviceTier, mode: action.mode }));
              } catch (error) {
                broadcast({ type: "error", threadId: rolledBack.thread.id, error: { code: "retry_failed", message: error instanceof Error ? error.message : "重发失败，历史已回退，请直接重新发送", retryable: true } }, rolledBack.thread.id);
              }
            });
            return;
          }
          if (action.type === "respond_request" && (typeof action.requestId === "string" || typeof action.requestId === "number")) { await codex.respond(action.requestId, action.response ?? {}); return; }
          socket.send(JSON.stringify({ type: "error", error: { code: "invalid_action", message: "不支持的操作", retryable: false } }));
          } catch (error) {
            socket.send(JSON.stringify({
              type: "error",
              threadId: typeof action.threadId === "string" ? action.threadId : undefined,
              turnId: typeof action.turnId === "string" ? action.turnId : undefined,
              error: { code: "action_failed", message: error instanceof Error ? error.message : "操作失败", retryable: true },
            }));
          }
      });
      socket.on("close", () => { sockets.delete(socket); subscriptions.delete(socket); });
    })();
  });

  const webRoot = path.resolve(process.cwd(), "dist/web");
  try { await daemon.register(fastifyStatic, { root: webRoot, prefix: "/" }); daemon.setNotFoundHandler((request, reply) => { if (request.url.startsWith("/api/") || request.url === "/ws") return reply.code(404).send({ ok: false, error: { code: "not_found", message: "Not found", retryable: false } }); return reply.sendFile("index.html"); }); } catch { daemon.log.warn("dist/web 不存在，开发模式请使用 Vite"); }
}

const cliHandled = await runCli();
if (!cliHandled) {
  await buildServer();
  await daemon.listen({ host: config.host, port: config.port });
  void codex.start().catch(() => daemon.log.warn("Codex app-server 初始化失败，发送请求时将重试"));
  daemon.log.info(`Codex Console listening on http://${config.host}:${config.port}`);
  process.once("SIGINT", async () => { await codex.stop(); await daemon.close(); process.exit(0); });
  process.once("SIGTERM", async () => { await codex.stop(); await daemon.close(); process.exit(0); });
}
