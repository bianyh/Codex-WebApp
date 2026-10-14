import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AdapterCapabilities, ConsoleEvent, Goal, ModelOption, PendingRequest, ThreadSnapshot, ThreadSummary, TimelineItem, ThreadStatus, TurnInput } from "./types.js";
import { config } from "./config.js";
import { goalFromRaw, goalUpdateSchema, type GoalUpdate } from "./goal.js";
import { mapTokenUsage, runtimeSettingsFromRaw, structuredItem } from "./runtimeMapping.js";
import { executionParams } from "./executionSettings.js";
import type { ExecutionSettings, RuntimeSettings } from "./types.js";

type RpcResponse = { id?: string | number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type RpcNotification = { method: string; id?: string | number; params?: Record<string, unknown> };
type RpcMessage = RpcResponse | RpcNotification;

type Listener = (event: ConsoleEvent) => void;
type RequestWaiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string }
  | { type: "localAudio"; path: string }
  | { type: "mention"; name: string; path: string };

function userInputFromTurn(input: TurnInput): CodexUserInput[] {
  const values: CodexUserInput[] = [];
  if (input.text.trim()) {
    values.push({ type: "text", text: input.text.trim(), text_elements: [] });
  }
  for (const attachment of input.attachments) {
    if (attachment.kind === "image") {
      values.push({ type: "localImage", path: attachment.path });
    } else if (attachment.kind === "audio") {
      values.push({ type: "localAudio", path: attachment.path });
    } else {
      values.push({ type: "mention", name: attachment.name, path: attachment.path });
    }
  }
  return values;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    const value = entry as Record<string, unknown>;
    return typeof value.text === "string" ? value.text : "";
  }).join("");
}

function errorTextFromRaw(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const error = value as Record<string, unknown>;
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const details = typeof error.additionalDetails === "string" ? error.additionalDetails.trim() : "";
    if (message && details && !message.includes(details)) return `${message}\n${details}`;
    if (message) return message;
    if (details) return details;
    if (typeof error.codexErrorInfo === "string") return error.codexErrorInfo;
  }
  return "Codex 执行失败，未返回详细错误信息";
}

function statusFromRaw(value: unknown): ThreadStatus {
  if (typeof value === "string") {
    if (value === "systemError") return "failed";
    if (["idle", "running", "waiting_approval", "waiting_input", "completed", "failed", "interrupted"].includes(value)) return value as ThreadStatus;
    return "unknown";
  }
  if (value && typeof value === "object") {
    const type = (value as Record<string, unknown>).type;
    if (typeof type === "string") {
      if (type === "active") {
        const flags = (value as Record<string, unknown>).activeFlags;
        if (Array.isArray(flags) && flags.includes("waitingOnApproval")) return "waiting_approval";
        if (Array.isArray(flags) && flags.includes("waitingOnUserInput")) return "waiting_input";
        return "running";
      }
      if (type.includes("awaiting") || type.includes("approval")) return "waiting_approval";
      if (type === "idle" || type === "notLoaded") return "idle";
      if (type === "completed") return "completed";
      if (type === "failed" || type === "systemError") return "failed";
      if (type === "interrupted") return "interrupted";
    }
  }
  return "unknown";
}

function summaryFromRaw(raw: unknown): ThreadSummary {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const preview = typeof value.preview === "string" ? value.preview : "";
  const name = typeof value.name === "string" && value.name ? value.name : preview;
  const created = typeof value.createdAt === "number" ? new Date(value.createdAt * 1000).toISOString() : undefined;
  const updated = typeof value.updatedAt === "number" ? new Date(value.updatedAt * 1000).toISOString() : undefined;
  return {
    id: String(value.id ?? ""),
    title: name || "Untitled thread",
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    status: statusFromRaw(value.status),
    updatedAt: updated ?? created,
    model: typeof value.model === "string" ? value.model : undefined,
    rolloutPath: typeof value.path === "string" ? value.path : undefined,
    runtimeSettings: runtimeSettingsFromRaw(value.runtimeSettings ?? value),
  };
}

function timestampToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function itemFromRaw(raw: unknown, fallbackCreatedAt?: string): TimelineItem {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = String(value.type ?? "unknown");
  const id = String(value.id ?? randomUUID());
  const createdAt = timestampToIso(value.createdAt ?? value.timestamp) ?? fallbackCreatedAt;
  const structured = structuredItem(value);
  if (structured?.kind) return { id, kind: structured.kind, createdAt, ...structured };
  if (type === "userMessage") return { id, kind: "user", createdAt, text: textFromContent(value.content) };
  if (type === "agentMessage") return { id, kind: "agent", createdAt, text: typeof value.text === "string" ? value.text : textFromContent(value.content), status: typeof value.phase === "string" ? value.phase : undefined };
  if (type === "reasoning") return { id, kind: "reasoning", createdAt, text: typeof value.text === "string" ? value.text : textFromContent(value.summary) || textFromContent(value.content), title: "Reasoning" };
  if (type === "commandExecution" || type === "command_execution") return { id, kind: "command", createdAt, command: typeof value.command === "string" ? value.command : undefined, output: typeof value.aggregatedOutput === "string" ? value.aggregatedOutput : typeof value.output === "string" ? value.output : undefined, status: typeof value.status === "string" ? value.status : undefined, title: "Command", exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined, durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined };
  if (type === "fileChange" || type === "file_change") {
    const changes = Array.isArray(value.changes) ? value.changes.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
    return { id, kind: "file_change", createdAt, path: typeof value.path === "string" ? value.path : typeof changes[0]?.path === "string" ? changes[0].path : undefined, diff: typeof value.diff === "string" ? value.diff : changes.map((change) => typeof change.diff === "string" ? change.diff : "").filter(Boolean).join("\n"), status: typeof value.status === "string" ? value.status : undefined, title: changes.length === 1 ? "File change" : `${changes.length} file changes`, metadata: { changes } };
  }
  if (type === "plan") return { id, kind: "plan", createdAt, text: typeof value.text === "string" ? value.text : textFromContent(value.content), title: "Plan" };
  if (type === "functionCallOutput" || type === "dynamicToolCall" || type.toLowerCase().includes("mcp")) {
    const result = value.result && typeof value.result === "object" ? value.result as Record<string, unknown> : undefined;
    const content = value.output ?? value.contentItems ?? result?.content ?? value.result ?? value.error;
    return { id, kind: "mcp", createdAt, title: typeof value.name === "string" ? value.name : typeof value.tool === "string" ? value.tool : "MCP tool", text: textFromContent(content) || (content && typeof content === "object" ? JSON.stringify(content, null, 2) : undefined), status: typeof value.status === "string" ? value.status : undefined, durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined };
  }
  return { id, kind: "unknown", createdAt, title: type, text: "当前版本尚未提供此事件的专用展示" };
}

function snapshotFromRaw(raw: Record<string, unknown>): ThreadSnapshot {
  const summary = summaryFromRaw(raw);
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const items = turns.flatMap((turn) => {
    const value = (turn && typeof turn === "object" ? turn : {}) as Record<string, unknown>;
    const startedAt = timestampToIso(value.startedAt) ?? summary.updatedAt;
    const mapped = Array.isArray(value.items) ? value.items.map((item) => itemFromRaw(item, startedAt)) : [];
    const lastAgent = [...mapped].reverse().find((item) => item.kind === "agent");
    if (lastAgent && !lastAgent.status && value.status === "completed") lastAgent.status = "final_answer";
    if (value.error) mapped.push({ id: `codex-error-${String(value.id ?? randomUUID())}`, kind: "system", createdAt: startedAt, title: "Codex 错误", text: errorTextFromRaw(value.error), status: "failed" });
    if (value.status === "inProgress" && typeof value.id === "string") summary.activeTurnId = value.id;
    return mapped;
  });
  const changedFiles: NonNullable<ThreadSnapshot["changedFiles"]> = [];
  for (const item of items) {
    if (item.kind !== "file_change" || !Array.isArray(item.metadata?.changes)) continue;
    for (const change of item.metadata.changes) {
      if (!change || typeof change.path !== "string") continue;
      const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
      const existing = changedFiles.find((file) => file.path === change.path);
      if (existing) existing.status = kind;
      else changedFiles.push({ path: change.path, status: typeof kind === "string" ? kind : undefined });
    }
  }
  return { thread: summary, items, pendingRequests: [], changedFiles, plan: [], diff: "" };
}

export function planFromRaw(value: unknown): NonNullable<ThreadSnapshot["plan"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ text: entry, completed: false }];
    if (!entry || typeof entry !== "object") return [];
    const step = entry as Record<string, unknown>;
    const text = typeof step.step === "string" ? step.step : typeof step.text === "string" ? step.text : "";
    return text ? [{ text, completed: step.status === "completed" || step.completed === true }] : [];
  });
}

export function tokenUsageFromRaw(value: unknown): ThreadSnapshot["tokenUsage"] {
  return mapTokenUsage(value);
}

export class CodexProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private waiters = new Map<string | number, RequestWaiter>();
  private listeners = new Set<Listener>();
  private lineBuffer = "";
  private starting: Promise<void> | null = null;
  private stopping = false;
  private loadedThreads = new Set<string>();
  private activeTurns = new Map<string, string>();
  private pendingRequests = new Map<string | number, { threadId?: string; request: PendingRequest }>();
  private settings = new Map<string, RuntimeSettings>();
  private _version = "unknown";
  private _capabilities: AdapterCapabilities = { codexVersion: "unknown", methods: [], supportsSteer: true, supportsApprovals: true, supportsDiff: true, supportsPlan: true };

  get version(): string { return this._version; }
  get capabilities(): AdapterCapabilities { return this._capabilities; }
  get pid(): number | undefined { return this.child?.pid; }
  getPendingRequests(threadId: string): PendingRequest[] { return [...this.pendingRequests.values()].filter((entry) => entry.threadId === threadId).map((entry) => entry.request); }
  activeTurnId(threadId: string): string | undefined {
    return this.activeTurns.get(threadId);
  }
  ownsTurn(threadId: string, turnId?: string): boolean {
    const ownedTurnId = this.activeTurns.get(threadId);
    return Boolean(ownedTurnId && (!turnId || ownedTurnId === turnId));
  }
  controlsThread(threadId: string): boolean { return this.loadedThreads.has(threadId); }
  runtimeSettings(threadId: string): RuntimeSettings | undefined { return this.settings.get(threadId); }
  async tryTakeControl(threadId: string): Promise<boolean> {
    if (this.loadedThreads.has(threadId)) return true;
    try {
      const result = await this.request("thread/resume", { threadId });
      this.settings.set(threadId, runtimeSettingsFromRaw(result));
      this.loadedThreads.add(threadId);
      return true;
    } catch {
      return false;
    }
  }

  onEvent(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = new Promise((resolve, reject) => {
      const child = spawn(config.codexCommand, ["app-server", "--listen", "stdio://"], { cwd: config.codexCwd, env: process.env });
      this.child = child;
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => this.handleLine(line));
      child.stderr.on("data", (chunk) => process.stderr.write(`[codex] ${String(chunk)}`));
      child.stdin.on("error", (error) => {
        if (!this.stopping) this.rejectAll(error);
      });
      child.once("error", (error) => {
        this.activeTurns.clear();
        this.loadedThreads.clear();
        this.settings.clear();
        this.rejectAll(error);
        if (!this.stopping) reject(error);
      });
      child.once("exit", (code, signal) => {
        this.child = null;
        this._version = "unknown";
        this.pendingRequests.clear();
        // Do not leave a turn owned by a process that no longer exists. The
        // activity tracker uses this map to decide whether a thread is
        // interruptible; stale entries make a restarted app-server look
        // permanently busy and prevent the next message from starting.
        this.activeTurns.clear();
        this.loadedThreads.clear();
        this.settings.clear();
        this.rejectAll(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
        this.emit({ sourceMethod: "server/exit", params: { code, signal } });
      });
      this.request("initialize", { clientInfo: { name: "codex_console", title: "Codex Console", version: "0.1.0" }, capabilities: { experimentalApi: true } }, 15000)
        .then((result) => {
          const value = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
          const userAgent = typeof value.userAgent === "string" ? value.userAgent : "";
          const match = userAgent.match(/codex[^/]*\/([^\s]+)/i);
          this._version = match?.[1] ?? userAgent.split(" ")[0] ?? "unknown";
          this._capabilities = { ...this._capabilities, codexVersion: this._version };
          this.notify("initialized", {});
          resolve();
        }).catch((error) => {
          this.activeTurns.clear();
          this.loadedThreads.clear();
          if (this.child === child) {
            this.child = null;
            child.kill("SIGTERM");
          }
          reject(error);
        }).finally(() => { this.starting = null; });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.activeTurns.clear();
    this.loadedThreads.clear();
    this.pendingRequests.clear();
    this.settings.clear();
    this._version = "unknown";
    this.rejectAll(new Error("Codex app-server stopped"));
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1500); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  }

  async request(method: string, params?: unknown, timeoutMs = 60000): Promise<unknown> {
    await this.startIfNeeded(method);
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("Codex app-server is unavailable");
    const id = this.nextId++;
    const message = JSON.stringify({ method, id, params: params ?? {} }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      child.stdin.write(message, (error) => {
        if (!error) return;
        const waiter = this.waiters.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
        waiter.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (child?.stdin.writable) child.stdin.write(JSON.stringify({ method, params: params ?? {} }) + "\n");
  }

  async listThreads(cwd?: string): Promise<ThreadSummary[]> {
    const result = await this.request("thread/list", { cwd: cwd ?? null, limit: 100, sortKey: "updated_at" });
    const data = (result && typeof result === "object" ? (result as Record<string, unknown>).data : []) as unknown[];
    return Array.isArray(data) ? data.map(summaryFromRaw).filter((item) => item.id) : [];
  }

  async listThreadPage(input: { cwd?: string; cursor?: string; archived?: boolean; searchTerm?: string }): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
    const result = await this.request("thread/list", { ...input, limit: 100, sortKey: "updated_at" }) as { data?: unknown[]; nextCursor?: string };
    return { threads: (result.data ?? []).map(summaryFromRaw).filter((thread) => thread.id), nextCursor: result.nextCursor ?? null };
  }

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      const value = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
      const data = Array.isArray(value.data) ? value.data : [];
      for (const raw of data) {
        if (!raw || typeof raw !== "object") continue;
        const model = raw as Record<string, unknown>;
        const id = typeof model.id === "string" ? model.id : "";
        const slug = typeof model.model === "string" ? model.model : id;
        if (!id || !slug) continue;
        models.push({
          id,
          model: slug,
          displayName:
            typeof model.displayName === "string" ? model.displayName : slug,
          description:
            typeof model.description === "string" ? model.description : "",
          isDefault: model.isDefault === true,
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts as ModelOption["supportedReasoningEfforts"] : [],
          defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : undefined,
          serviceTiers: Array.isArray(model.serviceTiers) ? model.serviceTiers as ModelOption["serviceTiers"] : [],
          defaultServiceTier: typeof model.defaultServiceTier === "string" ? model.defaultServiceTier : null,
          inputModalities: Array.isArray(model.inputModalities)
            ? model.inputModalities.filter(
                (entry): entry is "text" | "image" | "audio" =>
                  entry === "text" || entry === "image" || entry === "audio",
              )
            : ["text"],
        });
      }
      cursor = typeof value.nextCursor === "string" ? value.nextCursor : null;
    } while (cursor);
    return models;
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    const snapshot = snapshotFromRaw(await this.readRawThread(threadId));
    snapshot.thread.runtimeSettings = { ...snapshot.thread.runtimeSettings, ...this.settings.get(threadId) };
    snapshot.pendingRequests = this.getPendingRequests(threadId);
    return snapshot;
  }

  async getGoal(threadId: string): Promise<Goal | null> {
    const result = await this.request("thread/goal/get", { threadId }) as { goal: unknown };
    return goalFromRaw(result.goal, threadId);
  }

  async setGoal(threadId: string, update: GoalUpdate): Promise<Goal> {
    const input = goalUpdateSchema.parse(update);
    await this.ensureLoaded(threadId);
    const result = await this.request("thread/goal/set", { threadId, ...input, origin: "user" }) as { goal: unknown };
    const goal = goalFromRaw(result.goal, threadId);
    if (!goal) throw new Error("Codex 未返回更新后的目标");
    return goal;
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.ensureLoaded(threadId);
    await this.request("thread/goal/clear", { threadId, origin: "user" });
  }

  private async readRawThread(threadId: string): Promise<Record<string, unknown>> {
    const result = await this.request("thread/read", { threadId, includeTurns: false }) as { thread: Record<string, unknown> };
    const raw = result.thread;
    if (!raw || typeof raw.id !== "string") throw new Error("Codex 返回了无效的线程数据");
    if (raw.historyMode !== "paginated") {
      const history = await this.request("thread/read", { threadId, includeTurns: true }) as { thread: Record<string, unknown> };
      return history.thread;
    }
    const turns: unknown[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      let page: { data?: unknown[]; nextCursor?: string };
      try {
        page = await this.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "asc", itemsView: "full" }) as typeof page;
      } catch (error) {
        if (cursor === null && turns.length === 0 && error instanceof Error && /not materialized yet/i.test(error.message)) return { ...raw, turns: [] };
        throw error;
      }
      if (Array.isArray(page.data)) turns.push(...page.data);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (cursor && seen.has(cursor)) throw new Error("Codex 返回了重复的历史分页游标");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { ...raw, turns };
  }

  async startThread(input: { cwd?: string; model?: string; sandbox?: string; approvalPolicy?: string }): Promise<ThreadSnapshot> {
    const params = { cwd: input.cwd ?? config.codexCwd, model: input.model ?? null, sandbox: input.sandbox ?? null, approvalPolicy: input.approvalPolicy ?? null, ephemeral: false };
    const result = await this.request("thread/start", params);
    const thread = (result && typeof result === "object" ? (result as Record<string, unknown>).thread : result) as unknown;
    const summary = summaryFromRaw(thread);
    this.settings.set(summary.id, runtimeSettingsFromRaw(result));
    summary.runtimeSettings = this.settings.get(summary.id);
    this.loadedThreads.add(summary.id);
    return { thread: summary, items: [], pendingRequests: [], changedFiles: [], plan: [], diff: "" };
  }

  async resumeThread(threadId: string): Promise<ThreadSnapshot> { const result = await this.request("thread/resume", { threadId }); this.settings.set(threadId, runtimeSettingsFromRaw(result)); this.loadedThreads.add(threadId); return this.readThread(threadId); }
  async archiveThread(threadId: string): Promise<void> { await this.request("thread/archive", { threadId }); }
  async unarchiveThread(threadId: string): Promise<void> { await this.request("thread/unarchive", { threadId }); }

  async forkThread(threadId: string, lastTurnId?: string): Promise<ThreadSnapshot> {
    const result = await this.request("thread/fork", { threadId, ...(lastTurnId ? { lastTurnId } : {}), excludeTurns: true }) as { thread: { id: string } };
    this.loadedThreads.add(result.thread.id);
    this.settings.set(result.thread.id, runtimeSettingsFromRaw(result));
    return this.readThread(result.thread.id);
  }
  async startTurn(threadId: string, input: TurnInput, settings?: ExecutionSettings): Promise<unknown> {
    await this.ensureLoaded(threadId);
    const result = await this.request("turn/start", { threadId, input: userInputFromTurn(input), ...executionParams(settings ?? {}, this.settings.get(threadId)?.model) });
    const turn = result && typeof result === "object" ? (result as Record<string, unknown>).turn : undefined;
    if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") this.activeTurns.set(threadId, String((turn as Record<string, unknown>).id));
    return result;
  }

  async steerTurn(threadId: string, turnId: string, input: TurnInput): Promise<unknown> { return this.request("turn/steer", { threadId, expectedTurnId: turnId, input: userInputFromTurn(input) }); }
  async interruptTurn(threadId: string, turnId: string): Promise<unknown> { return this.request("turn/interrupt", { threadId, turnId }); }
  async rollbackLastTurn(threadId: string): Promise<ThreadSnapshot> {
    await this.ensureLoaded(threadId);
    const raw = await this.readRawThread(threadId);
    const turns = Array.isArray(raw.turns) ? raw.turns as Record<string, unknown>[] : [];
    const last = turns.at(-1);
    if (!last || typeof last.id !== "string") throw new Error("该线程没有可以回退的消息");
    if (last.status === "inProgress") throw new Error("请先中止当前运行，再重新发送最近消息");
    if (raw.historyMode === "paginated") {
      await this.request("thread/revert", { threadId, beforeTurnId: last.id });
      return this.readThread(threadId);
    }
    try {
      await this.request("thread/rollback", { threadId, numTurns: 1 });
      return this.readThread(threadId);
    } catch (error) {
      if (!(error instanceof Error) || !/unknown variant [`'"]thread\/rollback|method not found|unknown method/i.test(error.message)) throw error;
    }
    const previous = turns.at(-2);
    const settings = previous ? undefined : await this.request("thread/resume", { threadId }) as Record<string, unknown>;
    const sandbox = settings?.sandbox && typeof settings.sandbox === "object" ? settings.sandbox as Record<string, unknown> : undefined;
    const sandboxMode = sandbox?.type === "readOnly" ? "read-only" : sandbox?.type === "workspaceWrite" ? "workspace-write" : sandbox?.type === "dangerFullAccess" ? "danger-full-access" : undefined;
    const result = previous
      ? await this.request("thread/fork", { threadId, lastTurnId: previous.id }) as { thread: Record<string, unknown> }
      : await this.request("thread/start", { cwd: raw.cwd, model: settings?.model ?? raw.model ?? null, modelProvider: settings?.modelProvider ?? raw.modelProvider ?? null, approvalPolicy: settings?.approvalPolicy ?? null, sandbox: sandboxMode ?? null, config: typeof settings?.reasoningEffort === "string" ? { model_reasoning_effort: settings.reasoningEffort } : null, ephemeral: false }) as { thread: Record<string, unknown> };
    const replacement = snapshotFromRaw(result.thread);
    if (!replacement.thread.id) throw new Error("Codex 未返回重发分支的线程 ID");
    this.loadedThreads.add(replacement.thread.id);
    return this.readThread(replacement.thread.id);
  }
  async respond(requestId: string | number, response: unknown): Promise<void> {
    if (!this.pendingRequests.has(requestId)) throw new Error("该请求已处理或不存在，请刷新线程");
    await this.writeResponse(requestId, response);
    const pending = this.pendingRequests.get(requestId);
    this.pendingRequests.delete(requestId);
    this.emit({ sourceMethod: "serverRequest/resolved", params: { requestId, threadId: pending?.threadId } });
  }

  private async startIfNeeded(method: string): Promise<void> { if (!this.child && method !== "initialize") await this.start(); }
  private async ensureLoaded(threadId: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    const result = await this.request("thread/resume", { threadId });
    this.settings.set(threadId, runtimeSettingsFromRaw(result));
    this.loadedThreads.add(threadId);
  }

  private handleLine(line: string): void {
    this.lineBuffer = line;
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch { return; }
    if ("id" in message && message.id !== undefined && ("result" in message || "error" in message)) {
      const waiter = this.waiters.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer); this.waiters.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "Codex RPC error")); else waiter.resolve(message.result);
      return;
    }
    if ("method" in message && typeof message.method === "string") {
      const params: Record<string, unknown> = { ...(message.params ?? {}), ...(message.id !== undefined ? { requestId: message.id } : {}) };
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (threadId && message.method === "thread/settings/updated") this.settings.set(threadId, runtimeSettingsFromRaw(params.threadSettings));
      if (threadId && message.method === "model/rerouted") this.settings.set(threadId, { ...this.settings.get(threadId), model: typeof params.toModel === "string" ? params.toModel : undefined, reroutedFrom: typeof params.fromModel === "string" ? params.fromModel : undefined, rerouteReason: typeof params.reason === "string" ? params.reason : undefined });
      const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : undefined;
      if (message.id !== undefined) {
        const supported = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/permissions/requestApproval", "mcpServer/elicitation/request", "item/tool/call"];
        if (!supported.includes(message.method)) {
          this.child?.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } }) + "\n");
          this.emit({ sourceMethod: "configWarning", params: { threadId, message: `当前控制台不支持 Codex 请求 ${message.method}，已拒绝该请求` } });
          return;
        }
        const kind: PendingRequest["kind"] = message.method.includes("requestUserInput") ? "user_input" : message.method.includes("fileChange") ? "file_approval" : message.method.includes("permissions") ? "permissions" : message.method === "item/tool/call" ? "tool_call" : message.method.includes("elicitation") ? "elicitation" : "command_approval";
        const request: PendingRequest = {
          id: message.id, method: message.method, kind, title: kind === "user_input" ? "Codex 需要你的输入" : kind === "tool_call" ? "Codex 请求调用工具" : "Codex 请求执行操作",
          detail: typeof params.command === "string" ? params.command : typeof params.reason === "string" ? params.reason : typeof params.message === "string" ? params.message : "请确认 Codex 的请求",
          command: typeof params.command === "string" ? params.command : undefined,
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
          questions: Array.isArray(params.questions) ? params.questions as PendingRequest["questions"] : undefined,
          tool: typeof params.tool === "string" ? params.tool : undefined,
          arguments: params.arguments,
          permissions: params.permissions && typeof params.permissions === "object" ? params.permissions as Record<string, unknown> : undefined,
          requestedSchema: params.requestedSchema,
          url: typeof params.url === "string" ? params.url : undefined,
          createdAt: new Date().toISOString(),
        };
        this.pendingRequests.set(message.id, { threadId, request });
      }
      if (message.method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) this.pendingRequests.delete(params.requestId);
      if ((message.method === "turn/completed" || message.method === "turn/interrupted" || message.method === "thread/closed") && threadId) {
        for (const [id, pending] of this.pendingRequests) if (pending.threadId === threadId) this.pendingRequests.delete(id);
      }
      if (message.method === "turn/started" && threadId && turnId) {
        this.activeTurns.set(threadId, turnId);
      }
      if ((message.method === "turn/completed" || message.method === "turn/interrupted" || message.method === "thread/closed") && threadId) {
        if (message.method === "thread/closed") this.loadedThreads.delete(threadId);
        const activeTurnId = this.activeTurns.get(threadId);
        // A late completion from an older turn must not clear a newer turn.
        // Older app-server versions omitted the turn id, so retain the
        // historical behaviour only when no newer id is known.
        if (!turnId || !activeTurnId || activeTurnId === turnId) {
          this.activeTurns.delete(threadId);
        }
      }
      this.emit({ sourceMethod: message.method, params });
    }
  }

  private async writeResponse(id: string | number, result: unknown): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("Codex app-server is unavailable");
    child.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  private emit(raw: { sourceMethod: string; params: Record<string, unknown> }): void {
    const params = raw.params;
    const threadValue = params.thread;
    const threadId = typeof params.threadId === "string" ? params.threadId : threadValue && typeof threadValue === "object" && typeof (threadValue as Record<string, unknown>).id === "string" ? String((threadValue as Record<string, unknown>).id) : undefined;
    const event: ConsoleEvent = { eventId: randomUUID(), threadId, sourceMethod: raw.sourceMethod, receivedAt: new Date().toISOString(), event: params };
    for (const listener of this.listeners) listener(event);
  }

  private rejectAll(error: Error): void { for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.waiters.clear(); }
}

export { errorTextFromRaw, itemFromRaw, snapshotFromRaw, statusFromRaw, summaryFromRaw, userInputFromTurn };
