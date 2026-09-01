import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AdapterCapabilities, ConsoleEvent, ModelOption, PendingRequest, ThreadSnapshot, ThreadSummary, TimelineItem, ThreadStatus, TurnInput } from "./types.js";
import { config } from "./config.js";

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

function statusFromRaw(value: unknown): ThreadStatus {
  if (typeof value === "string") {
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
      if (type === "failed") return "failed";
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
    model: typeof value.modelProvider === "string" ? value.modelProvider : undefined,
    rolloutPath: typeof value.path === "string" ? value.path : undefined,
  };
}

function itemFromRaw(raw: unknown): TimelineItem {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = String(value.type ?? "unknown");
  const id = String(value.id ?? randomUUID());
  if (type === "userMessage") return { id, kind: "user", text: textFromContent(value.content) };
  if (type === "agentMessage") return { id, kind: "agent", text: typeof value.text === "string" ? value.text : textFromContent(value.content), status: typeof value.phase === "string" ? value.phase : undefined };
  if (type === "reasoning") return { id, kind: "reasoning", text: typeof value.text === "string" ? value.text : textFromContent(value.summary) || textFromContent(value.content), title: "Reasoning" };
  if (type === "commandExecution" || type === "command_execution") return { id, kind: "command", command: typeof value.command === "string" ? value.command : undefined, output: typeof value.aggregatedOutput === "string" ? value.aggregatedOutput : typeof value.output === "string" ? value.output : undefined, status: typeof value.status === "string" ? value.status : undefined, title: "Command" };
  if (type === "fileChange" || type === "file_change") {
    const changes = Array.isArray(value.changes) ? value.changes.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
    return { id, kind: "file_change", path: typeof value.path === "string" ? value.path : typeof changes[0]?.path === "string" ? changes[0].path : undefined, diff: typeof value.diff === "string" ? value.diff : changes.map((change) => typeof change.diff === "string" ? change.diff : "").filter(Boolean).join("\n"), status: typeof value.status === "string" ? value.status : undefined, title: changes.length === 1 ? "File change" : `${changes.length} file changes`, metadata: { changes } };
  }
  if (type === "plan") return { id, kind: "plan", text: typeof value.text === "string" ? value.text : textFromContent(value.content), title: "Plan" };
  if (type.toLowerCase().includes("mcp")) return { id, kind: "mcp", title: typeof value.name === "string" ? value.name : "MCP tool", text: typeof value.result === "string" ? value.result : undefined, status: typeof value.status === "string" ? value.status : undefined };
  return { id, kind: "unknown", title: type, metadata: value };
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
  private _version = "unknown";
  private _capabilities: AdapterCapabilities = { codexVersion: "unknown", methods: [], supportsSteer: true, supportsApprovals: true, supportsDiff: true, supportsPlan: true };

  get version(): string { return this._version; }
  get capabilities(): AdapterCapabilities { return this._capabilities; }
  get pid(): number | undefined { return this.child?.pid; }
  activeTurnId(threadId: string): string | undefined {
    return this.activeTurns.get(threadId);
  }
  ownsTurn(threadId: string, turnId?: string): boolean {
    const ownedTurnId = this.activeTurns.get(threadId);
    return Boolean(ownedTurnId && (!turnId || ownedTurnId === turnId));
  }
  controlsThread(threadId: string): boolean { return this.loadedThreads.has(threadId); }
  async tryTakeControl(threadId: string): Promise<boolean> {
    if (this.loadedThreads.has(threadId)) return true;
    try {
      await this.request("thread/resume", { threadId });
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
      child.once("error", (error) => {
        this.activeTurns.clear();
        this.loadedThreads.clear();
        this.rejectAll(error);
        if (!this.stopping) reject(error);
      });
      child.once("exit", (code, signal) => {
        this.child = null;
        // Do not leave a turn owned by a process that no longer exists. The
        // activity tracker uses this map to decide whether a thread is
        // interruptible; stale entries make a restarted app-server look
        // permanently busy and prevent the next message from starting.
        this.activeTurns.clear();
        this.loadedThreads.clear();
        this.rejectAll(new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`));
        this.emit({ sourceMethod: "server/exit", params: { code, signal } });
      });
      this.request("initialize", { clientInfo: { name: "codex_console", title: "Codex Console", version: "0.1.0" } }, 15000)
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
    child.stdin.write(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
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
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    const raw = (result && typeof result === "object" ? (result as Record<string, unknown>).thread : {}) as Record<string, unknown>;
    const turns = Array.isArray(raw.turns) ? raw.turns : [];
    const items = turns.flatMap((turn) => {
      const t = (turn && typeof turn === "object" ? turn : {}) as Record<string, unknown>;
      if (!Array.isArray(t.items)) return [];
      const mapped = t.items.map(itemFromRaw);
      // Some older providers omit MessagePhase. The last assistant message
      // in a completed turn is still the user-visible final reply; mark it so
      // the UI can separate it from progress narration.
      const lastAgent = [...mapped].reverse().find((item) => item.kind === "agent");
      if (lastAgent && !lastAgent.status) lastAgent.status = "final_answer";
      return mapped;
    });
    return { thread: summaryFromRaw(raw), items, pendingRequests: [], changedFiles: [], plan: [], diff: "" };
  }

  async startThread(input: { cwd?: string; model?: string; sandbox?: string; approvalPolicy?: string }): Promise<ThreadSnapshot> {
    const params = { cwd: input.cwd ?? config.codexCwd, model: input.model ?? null, sandbox: input.sandbox ?? null, approvalPolicy: input.approvalPolicy ?? null, ephemeral: false };
    const result = await this.request("thread/start", params);
    const thread = (result && typeof result === "object" ? (result as Record<string, unknown>).thread : result) as unknown;
    const summary = summaryFromRaw(thread);
    this.loadedThreads.add(summary.id);
    return { thread: summary, items: [], pendingRequests: [], changedFiles: [], plan: [], diff: "" };
  }

  async resumeThread(threadId: string): Promise<ThreadSnapshot> { await this.request("thread/resume", { threadId }); this.loadedThreads.add(threadId); return this.readThread(threadId); }
  async archiveThread(threadId: string): Promise<void> { await this.request("thread/archive", { threadId }); }
  async unarchiveThread(threadId: string): Promise<void> { await this.request("thread/unarchive", { threadId }); }

  async startTurn(threadId: string, input: TurnInput, settings?: { model?: string; effort?: string; sandboxPolicy?: unknown; approvalPolicy?: string }): Promise<unknown> {
    await this.ensureLoaded(threadId);
    const result = await this.request("turn/start", { threadId, input: userInputFromTurn(input), model: settings?.model ?? null, effort: settings?.effort ?? null, sandboxPolicy: settings?.sandboxPolicy ?? null, approvalPolicy: settings?.approvalPolicy ?? null });
    const turn = result && typeof result === "object" ? (result as Record<string, unknown>).turn : undefined;
    if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") this.activeTurns.set(threadId, String((turn as Record<string, unknown>).id));
    return result;
  }

  async steerTurn(threadId: string, turnId: string, input: TurnInput): Promise<unknown> { return this.request("turn/steer", { threadId, expectedTurnId: turnId, input: userInputFromTurn(input) }); }
  async interruptTurn(threadId: string, turnId: string): Promise<unknown> { return this.request("turn/interrupt", { threadId, turnId }); }
  async rollbackLastTurn(threadId: string): Promise<void> {
    await this.ensureLoaded(threadId);
    await this.request("thread/rollback", { threadId, numTurns: 1 });
  }
  async respond(requestId: string | number, response: unknown): Promise<void> { await this.writeResponse(requestId, response); }

  private async startIfNeeded(method: string): Promise<void> { if (!this.child && method !== "initialize") await this.start(); }
  private async ensureLoaded(threadId: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId });
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
      const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : undefined;
      if (message.method === "turn/started" && threadId && turnId) {
        this.activeTurns.set(threadId, turnId);
      }
      if ((message.method === "turn/completed" || message.method === "turn/interrupted" || message.method === "thread/closed") && threadId) {
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

export { itemFromRaw, summaryFromRaw, userInputFromTurn };
