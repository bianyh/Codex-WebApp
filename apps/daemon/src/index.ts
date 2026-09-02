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
import { loadState, getState, persistState } from "./state.js";
import { authenticated, login, logout, requireAuth, setPassword } from "./auth.js";
import { CodexProcess, itemFromRaw } from "./codex.js";
import { ExternalCodexController } from "./externalCodex.js";
import { ThreadActivityTracker, type ThreadActivity } from "./threadActivity.js";
import type { ConsoleEvent, ThreadSnapshot, ThreadStatus, ThreadSummary, TurnAttachment, TurnInput } from "./types.js";

const daemon = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const codex = new CodexProcess();
const sockets = new Set<WebSocket>();
const eventBuffer: ConsoleEvent[] = [];
const snapshots = new Map<string, ThreadSnapshot>();
const knownThreads = new Map<string, ThreadSummary>();
const lastActivities = new Map<string, ThreadActivity>();
const subscriptions = new Map<WebSocket, string>();
const externalCodex = new ExternalCodexController({
  isIgnoredPid: (pid) => pid === codex.pid,
});
type QueuedTurn = TurnInput & { id: string; model?: string };
const queuedTurns = new Map<string, QueuedTurn[]>();
const drainingQueues = new Set<string>();
const turnOperations = new Map<string, Promise<void>>();
let refreshingActivities: Promise<void> | null = null;
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
  return { ...snapshot, thread: publicThread(snapshot.thread) };
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

function queueTurn(threadId: string, input: TurnInput, model?: string): string {
  const id = randomUUID();
  const queue = queuedTurns.get(threadId) ?? [];
  queue.push({ id, ...input, model });
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
  const queue = queuedTurns.get(threadId);
  const thread = knownThreads.get(threadId);
  if (!queue?.length || !thread) return;
  const activity = await activityTracker.inspect(thread);
  if (isTurnActiveStatus(activity.status)) return;
  drainingQueues.add(threadId);
  try {
    if (!(await takeControl(thread))) return;
    const next = queue[0];
    if (!next) return;
    await codex.startTurn(
      threadId,
      { text: next.text, attachments: next.attachments },
      { model: next.model },
    );
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
  } finally {
    drainingQueues.delete(threadId);
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
  const requestKind = event.sourceMethod.includes("requestUserInput")
    ? "user_input"
    : event.sourceMethod.includes("fileChange")
      ? "file_approval"
      : event.sourceMethod.includes("permissions")
        ? "permissions"
        : event.sourceMethod === "item/tool/call"
          ? "tool_call"
          : event.sourceMethod.includes("elicitation")
            ? "elicitation"
            : "command_approval";
  const payload = isRequest
    ? JSON.stringify({ type: "server_request", eventId: event.eventId, threadId: event.threadId, request: { id: event.event.requestId, method: event.sourceMethod, kind: requestKind, title: event.sourceMethod.includes("requestUserInput") ? "Codex 需要你的输入" : event.sourceMethod === "item/tool/call" ? "Codex 请求调用工具" : "Codex 请求执行操作", detail: typeof event.event.command === "string" ? event.event.command : typeof event.event.reason === "string" ? event.event.reason : event.sourceMethod === "item/tool/call" ? `${String(event.event.namespace ?? "")} ${String(event.event.tool ?? "未知工具")}`.trim() : "请确认 Codex 的请求", command: typeof event.event.command === "string" ? event.event.command : undefined, cwd: typeof event.event.cwd === "string" ? event.event.cwd : undefined, questions: Array.isArray(event.event.questions) ? event.event.questions : undefined, tool: typeof event.event.tool === "string" ? event.event.tool : undefined, arguments: event.event.arguments, createdAt: event.receivedAt } })
    : JSON.stringify({ type: "thread_event", eventId: event.eventId, threadId: event.threadId, event: { method: event.sourceMethod, params: event.event, receivedAt: event.receivedAt } });
  for (const socket of sockets) {
    // A mobile client subscribes to one thread. Sending every other thread's
    // delta can saturate a slow connection while another session is active.
    if (event.threadId && subscriptions.get(socket) !== event.threadId) continue;
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function updateSnapshot(event: ConsoleEvent): void {
  if (!event.threadId) return;
  const snapshot = snapshots.get(event.threadId);
  if (!snapshot) return;
  const params = event.event;
  const method = event.sourceMethod;
  if (method === "item/agentMessage/delta") {
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
    const mapped = itemFromRaw(params.item);
    const index = snapshot.items.findIndex((candidate) => candidate.id === mapped.id);
    if (index >= 0) snapshot.items[index] = { ...snapshot.items[index], ...mapped };
    else snapshot.items.push(mapped);
    if (mapped.kind === "file_change") {
      const changes = Array.isArray(mapped.metadata?.changes) ? mapped.metadata.changes.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
      snapshot.changedFiles ??= [];
      for (const change of changes) {
        if (typeof change.path !== "string") continue;
        const existing = snapshot.changedFiles.find((entry) => entry.path === change.path);
        const status = typeof change.kind === "string" ? change.kind : mapped.status ?? "modified";
        if (existing) existing.status = status; else snapshot.changedFiles.push({ path: change.path, status });
      }
      if (mapped.diff) snapshot.diff = mapped.diff;
    }
  } else if (method === "turn/completed") {
    const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : undefined;
    const terminalStatus = typeof turn?.status === "string" ? turn.status : typeof params.status === "string" ? params.status : "completed";
    snapshot.thread.status = terminalStatus === "interrupted" ? "interrupted" : terminalStatus === "failed" || terminalStatus === "systemError" ? "failed" : "completed";
    snapshot.thread.activeTurnId = undefined;
    snapshot.thread.canInterrupt = false;
  } else if (method === "thread/status/changed") {
    const status = params.status;
    if (typeof status === "string") snapshot.thread.status = status as typeof snapshot.thread.status;
    else if (status && typeof status === "object" && typeof (status as Record<string, unknown>).type === "string") snapshot.thread.status = String((status as Record<string, unknown>).type) as typeof snapshot.thread.status;
  } else if (method === "turn/diff/updated") {
    snapshot.diff = typeof params.diff === "string" ? params.diff : snapshot.diff;
  } else if (method === "turn/plan/updated") {
    const plan = params.plan;
    if (Array.isArray(plan)) snapshot.plan = plan.map((entry) => typeof entry === "string" ? ({ text: entry }) : ({ text: String((entry as Record<string, unknown>).text ?? ""), completed: Boolean((entry as Record<string, unknown>).completed) }));
  } else if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage;
    if (usage && typeof usage === "object") snapshot.tokenUsage = usage as ThreadSnapshot["tokenUsage"];
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

function isLocalPath(value: string): Promise<string> {
  const candidate = path.isAbsolute(value) ? value : path.join(config.workspaceRoot, value);
  return realpath(candidate).then((resolved) => {
    const root = config.workspaceRoot;
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`路径必须位于工作区 ${root} 内`);
    return resolved;
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
  daemon.addHook("onClose", async () => { clearInterval(activityTimer); });
  daemon.get("/api/healthz", async (request) => ok(request, { ok: true, daemonVersion: "0.1.0", codexVersion: codex.version, appServer: codex.version === "unknown" ? "starting" : "ready", activeThreads: [...lastActivities.values()].filter((activity) => isTurnActiveStatus(activity.status)).length, loadedThreads: snapshots.size, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
  daemon.post<{ Body: { password?: string } }>("/api/auth/login", async (request, reply) => { await login(request, reply, typeof request.body?.password === "string" ? request.body.password : ""); return; });
  daemon.post("/api/auth/logout", async (request, reply) => { if (!(await requireAuth(request, reply))) return; await logout(request, reply); });
  daemon.get("/api/auth/me", async (request, reply) => { if (!(await requireAuth(request, reply))) return; return ok(request, { authenticated: true, passwordConfigured: Boolean(getState().passwordHash), codexVersion: codex.version }); });
  daemon.get("/api/models", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      return ok(request, await codex.listModels());
    } catch (error) {
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
      const directory = await isLocalPath(request.query.path || config.workspaceRoot);
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory()) {
        return reply.code(400).send(failure(request, "not_directory", "上传目标不是文件夹"));
      }
      const storedPath = path.join(directory, name);
      await writeFile(storedPath, body, { mode: 0o600, flag: "wx" });
      const metadata = await stat(storedPath);
      return reply.code(201).send(ok(request, {
        name,
        path: storedPath,
        type: "file",
        kind: fileKind(storedPath),
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
      const canonicalPath = await isLocalPath(parsed.data.path);
      const project = { id: crypto.randomUUID(), name: parsed.data.name, canonicalPath, enabled: true };
      getState().projects.push(project); await persistState(); return reply.code(201).send(ok(request, project));
    } catch (error) { return reply.code(400).send(failure(request, "invalid_path", error instanceof Error ? error.message : "项目路径无效")); }
  });

  daemon.get<{ Querystring: { path?: string } }>("/api/fs/list", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return;
    try {
      const directory = await isLocalPath(request.query.path || config.workspaceRoot);
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory()) return reply.code(400).send(failure(request, "not_directory", "所选路径不是文件夹"));
      const dirents = await readdir(directory, { withFileTypes: true });
      const entries = await Promise.all(dirents.slice(0, 1000).map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        try {
          const resolved = await isLocalPath(entryPath);
          const metadata = await stat(resolved);
          return { name: entry.name, path: resolved, type: metadata.isDirectory() ? "directory" : "file", kind: metadata.isDirectory() ? "directory" : fileKind(resolved), size: metadata.size, modifiedAt: metadata.mtime.toISOString(), hidden: entry.name.startsWith(".") };
        } catch { return null; }
      }));
      const visible = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
      return ok(request, { path: directory, root: config.workspaceRoot, parent: directory === config.workspaceRoot ? null : path.dirname(directory), entries: visible, truncated: dirents.length > 1000 });
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
      const parent = await isLocalPath(parsed.data.parent);
      if (!(await stat(parent)).isDirectory()) return reply.code(400).send(failure(request, "not_directory", "父路径不是文件夹"));
      const directory = path.join(parent, parsed.data.name);
      await mkdir(directory, { mode: 0o700 });
      const canonicalPath = await isLocalPath(directory);
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
      const filePath = await isLocalPath(request.query.path);
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
      const filePath = await isLocalPath(request.query.path);
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

  daemon.get<{ Querystring: { cwd?: string } }>("/api/threads", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { const threads = await codex.listThreads(request.query.cwd); const enriched = await Promise.all(threads.map(async (thread) => { knownThreads.set(thread.id, thread); const result = await activityTracker.enrich(thread); result.canRetry = !isTurnActiveStatus(result.status) && codex.controlsThread(result.id); knownThreads.set(result.id, result); return publicThread(result); })); return ok(request, enriched); } catch (error) { return reply.code(503).send(failure(request, "codex_unavailable", error instanceof Error ? error.message : "Codex 不可用", true)); } });
  daemon.get<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { const snapshot = await codex.readThread(request.params.threadId); snapshot.thread = await activityTracker.enrich(snapshot.thread); if (!isTurnActiveStatus(snapshot.thread.status)) await codex.tryTakeControl(snapshot.thread.id); snapshot.thread.canRetry = !isTurnActiveStatus(snapshot.thread.status) && codex.controlsThread(snapshot.thread.id); knownThreads.set(snapshot.thread.id, snapshot.thread); snapshots.set(snapshot.thread.id, snapshot); return ok(request, publicSnapshot(snapshot)); } catch (error) { return reply.code(404).send(failure(request, "thread_not_found", error instanceof Error ? error.message : "线程不存在")); } });
  daemon.post<{ Body: { cwd?: string; model?: string; sandbox?: string; approvalPolicy?: string } }>("/api/threads", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { const body = request.body ?? {}; if (body.cwd) body.cwd = await isLocalPath(body.cwd); const snapshot = await codex.startThread(body); snapshot.thread.canRetry = true; knownThreads.set(snapshot.thread.id, snapshot.thread); snapshots.set(snapshot.thread.id, snapshot); return reply.code(201).send(ok(request, publicSnapshot(snapshot))); } catch (error) { return reply.code(503).send(failure(request, "codex_unavailable", error instanceof Error ? error.message : "无法创建线程", true)); } });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/resume", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { const snapshot = await codex.resumeThread(request.params.threadId); snapshot.thread.canRetry = true; knownThreads.set(snapshot.thread.id, snapshot.thread); snapshots.set(snapshot.thread.id, snapshot); return ok(request, publicSnapshot(snapshot)); } catch (error) { return reply.code(503).send(failure(request, "resume_failed", error instanceof Error ? error.message : "无法恢复线程", true)); } });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/archive", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { await codex.archiveThread(request.params.threadId); snapshots.delete(request.params.threadId); return ok(request, null); } catch (error) { return reply.code(503).send(failure(request, "archive_failed", error instanceof Error ? error.message : "无法归档线程", true)); } });
  daemon.post<{ Params: { threadId: string } }>("/api/threads/:threadId/unarchive", async (request, reply) => { if (!(await requireAuth(request, reply))) return; try { await codex.unarchiveThread(request.params.threadId); return ok(request, null); } catch (error) { return reply.code(503).send(failure(request, "unarchive_failed", error instanceof Error ? error.message : "无法恢复线程", true)); } });

  daemon.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    void (async () => {
      if (!allowedOrigin(request.headers.origin)) { socket.close(4403, "Invalid origin"); return; }
      if (!(await authenticated(request))) { socket.close(4401, "Unauthenticated"); return; }
      sockets.add(socket);
      socket.send(JSON.stringify({ type: "server_ready", codexVersion: codex.version, capabilities: codex.capabilities }));
      socket.on("message", async (raw) => {
        try {
          const action = JSON.parse(String(raw)) as Record<string, unknown>;
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
              queue: queue.map((item) => ({
                id: item.id,
                text: item.text,
                attachments: item.attachments.map(({ name, kind, size }) => ({ name, kind, size })),
              })),
            }));
            const lastEventId = typeof action.lastEventId === "string" ? action.lastEventId : undefined;
            const index = lastEventId ? eventBuffer.findIndex((event) => event.eventId === lastEventId) : -1;
            if (lastEventId && index >= 0) for (const event of eventBuffer.slice(index + 1)) if (!event.threadId || event.threadId === action.threadId) socket.send(JSON.stringify({ type: "thread_event", eventId: event.eventId, threadId: event.threadId, event: { method: event.sourceMethod, params: event.event } }));
            return;
          }
          if (action.type === "start_turn" && typeof action.threadId === "string" && (typeof action.text === "string" || Array.isArray(action.attachments))) {
            await serializeTurnOperation(action.threadId, async () => {
              const thread = knownThreads.get(action.threadId as string) ?? snapshots.get(action.threadId as string)?.thread;
              if (!thread) throw new Error("线程尚未加载");
              const input = await resolveTurnInput(action);
              const model = typeof action.model === "string" && action.model ? action.model : undefined;
              const activity = await activityTracker.inspect(thread);
              if (isTurnActiveStatus(activity.status)) {
                queueTurn(action.threadId as string, input, model);
                return;
              }
              if (!(await takeControl(thread))) {
                queueTurn(action.threadId as string, input, model);
                return;
              }
              thread.status = "running";
              const snapshot = snapshots.get(action.threadId as string); if (snapshot) snapshot.thread.status = "running";
              await codex.startTurn(action.threadId as string, input, { model, effort: typeof action.effort === "string" ? action.effort : undefined });
            });
            return;
          }
          if (action.type === "steer_turn" && typeof action.threadId === "string" && typeof action.turnId === "string" && (typeof action.text === "string" || Array.isArray(action.attachments))) {
            await serializeTurnOperation(action.threadId, async () => {
              const input = await resolveTurnInput(action);
              if (codex.ownsTurn(action.threadId as string, action.turnId as string)) {
                await codex.steerTurn(action.threadId as string, action.turnId as string, input);
              } else {
                queueTurn(action.threadId as string, input, typeof action.model === "string" ? action.model : undefined);
              }
            });
            return;
          }
          if (action.type === "queue_turn" && typeof action.threadId === "string" && (typeof action.text === "string" || Array.isArray(action.attachments))) {
            await serializeTurnOperation(action.threadId, async () => {
              const input = await resolveTurnInput(action);
              queueTurn(action.threadId as string, input, typeof action.model === "string" ? action.model : undefined);
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
              const activity = await activityTracker.inspect(knownThreads.get(action.threadId as string) ?? snapshots.get(action.threadId as string)?.thread ?? { id: action.threadId as string, title: "", status: "unknown" });
              if (isTurnActiveStatus(activity.status)) throw new Error("请先中止当前运行，再编辑并重新发送最近消息");
              await codex.rollbackLastTurn(action.threadId as string);
              const rolledBack = await codex.readThread(action.threadId as string);
              rolledBack.thread.canRetry = true;
              knownThreads.set(rolledBack.thread.id, rolledBack.thread);
              snapshots.set(rolledBack.thread.id, rolledBack);
              broadcast({ type: "thread_snapshot", eventId: randomUUID(), snapshot: publicSnapshot(rolledBack) }, action.threadId as string);
              await codex.startTurn(action.threadId as string, { text: action.text as string, attachments: [] }, { model: typeof action.model === "string" && action.model ? action.model : undefined });
            });
            return;
          }
          if (action.type === "respond_request" && (typeof action.requestId === "string" || typeof action.requestId === "number")) { await codex.respond(action.requestId, action.response ?? {}); return; }
          socket.send(JSON.stringify({ type: "error", error: { code: "invalid_action", message: "不支持的操作", retryable: false } }));
        } catch (error) { socket.send(JSON.stringify({ type: "error", error: { code: "action_failed", message: error instanceof Error ? error.message : "操作失败", retryable: true } })); }
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
  daemon.log.info(`Codex Console listening on http://${config.host}:${config.port}`);
  process.once("SIGINT", async () => { await codex.stop(); await daemon.close(); process.exit(0); });
  process.once("SIGTERM", async () => { await codex.stop(); await daemon.close(); process.exit(0); });
}
