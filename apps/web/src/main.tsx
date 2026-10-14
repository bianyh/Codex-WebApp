import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  CircleAlert,
  Code2,
  Copy,
  Cpu,
  File as FileIcon,
  FileCode2,
  Folder,
  GitBranch,
  ListChecks,
  LoaderCircle,
  LogOut,
  Moon,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  Paperclip,
  Pause,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Square,
  Sun,
  Target,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import type {
  Item,
  GoalState,
  ModelOption,
  RequestItem,
  Snapshot,
  ThemeMode,
  Thread,
  TimelineEvent,
  UploadAttachment,
  ExecutionSettings,
  QueueEntry,
} from "./types";
import { FilePreview, WorkspaceFiles, fileEntryFromPath, type FsEntry } from "./WorkspaceFiles";
import { resolveLocalFileHref } from "./fileLinks";
import { normalizeMarkdownMath } from "./markdown";
import { createOptimisticUserItem, mergeTimelineItem, textFromRawItem } from "./messageState";
import { formatMessageTimestamp } from "./messageTime";
import { NewThreadDialog } from "./NewThreadDialog";
import { SettingsDialog } from "./SettingsDialog";
import { CommandPanel } from "./CommandPanel";
import { createCommandId } from "./commandId";
import { ErrorBoundary } from "./ErrorBoundary";
import { changeStatusFromRaw, planFromRaw, tokenUsageFromRaw } from "./protocolMapping";
import { responseForRequest } from "./requestResponse";
import { GoalPanel, type GoalControls } from "./GoalPanel";
import { goalStatusLabels } from "./goalState";
import { useGoal } from "./useGoal";
import { QueuePanel, RuntimeStatusPanel, UsagePanel } from "./RuntimePanels";
import { ExecutionSettingsMenu } from "./ExecutionSettingsMenu";
import { useThreadEntryScroll } from "./useThreadEntryScroll";
import { StructuredItem } from "./StructuredItem";
import { ThreadActions } from "./ThreadActions";
import { runtimeSettingsFromRaw, structuredItem } from "../../daemon/src/runtimeMapping";
import "./styles.css";
import "katex/dist/katex.min.css";

const initialTheme = (): ThemeMode => {
  const saved = localStorage.getItem("codex-console-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

const storedThreadModels = (): Record<string, string> => {
  try {
    const value = JSON.parse(localStorage.getItem("codex-console-thread-models") ?? "{}");
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch {
    return {};
  }
};

const storedBoolean = (key: string): boolean => localStorage.getItem(key) === "true";

const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "请求失败");
  return body?.data as T;
};

function filesFromClipboard(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  const keys = new Set(files.map((file) => `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`));
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const key = `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
    if (!keys.has(key)) {
      keys.add(key);
      files.push(file);
    }
  }
  return files;
}

const MessageMarkdown = memo(function MessageMarkdown({ text, cwd, onOpenFile }: { text: string; cwd?: string; onOpenFile?: (entry: FsEntry) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ href, children, node: _node, ...props }) => {
          const filePath = resolveLocalFileHref(href, cwd);
          if (filePath && onOpenFile) {
            return (
              <a
                {...props}
                href={href}
                title={`预览文件：${filePath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenFile(fileEntryFromPath(filePath));
                }}
              >
                {children}
              </a>
            );
          }
          return <a {...props} href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel={href?.startsWith("#") ? undefined : "noreferrer"}>{children}</a>;
        },
      }}
    >
      {normalizeMarkdownMath(text)}
    </ReactMarkdown>
  );
});

type TimelineSegment =
  | { kind: "user" | "final" | "system"; items: Item[] }
  | { kind: "process"; items: Item[] };

const INITIAL_TIMELINE_ITEMS = 240;
const TIMELINE_CHUNK_SIZE = 240;
const TIMELINE_MAX_ITEMS = 360;

function codexErrorText(params: Record<string, unknown>): string {
  const value = params.error;
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
  if (typeof params.message === "string" && params.message.trim()) return params.message.trim();
  if (typeof params.additionalDetails === "string" && params.additionalDetails.trim()) return params.additionalDetails.trim();
  return "Codex 执行失败，未返回详细错误信息";
}

function isFinalAgentMessage(item: Item): boolean {
  return item.kind === "agent" && (item.status === "final_answer" || item.status === "final");
}

function segmentTimeline(items: Item[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const item of items) {
    const kind: TimelineSegment["kind"] = item.kind === "user"
      ? "user"
      : item.kind === "system"
        ? "system"
      : isFinalAgentMessage(item)
        ? "final"
        : "process";
    const previous = segments[segments.length - 1];
    if (previous?.kind === kind) previous.items.push(item);
    else segments.push({ kind, items: [item] } as TimelineSegment);
  }
  return segments;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <div className="login-orbit" />
      <section className="login-panel">
        <div className="brand-mark">
          <Code2 size={20} />
        </div>
        <p className="eyebrow">LOCAL CONTROL PLANE</p>
        <h1>Codex Console</h1>
        <p className="login-copy">
          在本机继续你的 Codex 会话。对话、代码和凭据都留在这台机器上。
        </p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="password">登录密码</label>
          <input
            id="password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入控制台密码"
            autoComplete="current-password"
          />
          <button className="primary-button wide" disabled={busy || !password}>
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Zap size={17} />
            )}
            登录
          </button>
          {error && (
            <p className="form-error">
              <CircleAlert size={15} />
              {error}
            </p>
          )}
        </form>
        <p className="login-footnote">
          首次使用请在本机运行 <code>npm run start -- password set</code>
        </p>
      </section>
    </main>
  );
}

function StatusPill({ status }: { status: Thread["status"] }) {
  const map: Record<string, [string, string]> = {
    running: ["运行中", "running"],
    waiting_approval: ["等待审批", "waiting"],
    waiting_input: ["等待输入", "waiting"],
    completed: ["已完成", "done"],
    failed: ["失败", "failed"],
    interrupted: ["已中断", "muted"],
    idle: ["待命", "muted"],
    unknown: ["未知", "muted"],
  };
  const [label, cls] = (map[status] ?? map.unknown)!;
  return (
    <span className={`status-pill ${cls}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function isTurnActiveStatus(status: Thread["status"] | undefined): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_input";
}

function itemTimestamp(item: Item): string {
  return formatMessageTimestamp(item.createdAt);
}

function ThreadDrawer({
  threads,
  selected,
  onSelect,
  onCreate,
  onSettings,
  onCollapse,
  open,
  onClose,
  query,
  onQuery,
  archived,
  onArchived,
  nextCursor,
  onMore,
}: {
  threads: Thread[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  onCollapse: () => void;
  open: boolean;
  onClose: () => void;
  query: string;
  onQuery: (query: string) => void;
  archived: boolean;
  onArchived: (value: boolean) => void;
  nextCursor: string | null;
  onMore: () => void;
}) {
  const filtered = threads;
  return (
    <aside className={`drawer ${open ? "open" : ""}`}>
      <div className="drawer-top">
        <div className="brand">
          <div className="brand-mark small">
            <Code2 size={16} />
          </div>
          <span>Codex Console</span>
        </div>
        <div className="drawer-head-actions">
          <button className="icon-button desktop-only" onClick={onCollapse} aria-label="收起线程侧栏" title="收起线程侧栏"><PanelLeftClose size={18} /></button>
          <button className="icon-button mobile-only" onClick={onClose} aria-label="关闭侧栏"><X size={18} /></button>
        </div>
      </div>
      <button className="new-thread-button" onClick={onCreate}>
        <Plus size={17} />
        新建线程
      </button>
      <div className="search-box">
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="搜索线程"
        />
      </div>
      <div className="drawer-section-label">
        <span>{archived ? "归档线程" : "最近线程"}</span>
        <span className="count">{filtered.length}</span>
      </div>
      <div className="thread-list">
        {filtered.map((thread) => (
          <button
            key={thread.id}
            className={`thread-row ${selected === thread.id ? "selected" : ""}`}
            onClick={() => {
              onSelect(thread.id);
              onClose();
            }}
          >
            <MessageSquare size={15} />
            <span className="thread-row-copy">
              <strong>{thread.title || "未命名线程"}</strong>
              <small>{thread.cwd?.split("/").pop() ?? "本机工作区"}</small>
            </span>
            <StatusPill status={thread.status} />
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="empty-small">没有匹配的线程</div>
        )}
        {nextCursor && <button className="drawer-action" onClick={onMore}>加载更多线程</button>}
      </div>
      <div className="drawer-bottom">
        <button className="drawer-action" onClick={() => onArchived(!archived)}>
          <Archive size={16} />
          {archived ? "返回最近线程" : "归档"}
        </button>
        <button className="drawer-action" onClick={onSettings}>
          <Settings size={16} />
          设置
        </button>
      </div>
    </aside>
  );
}

const TimelineItem = memo(function TimelineItem({ item, cwd, isLastUser = false, editable = false, editUnavailableReason, onEdit, onOpenFile }: { item: Item; cwd?: string; isLastUser?: boolean; editable?: boolean; editUnavailableReason?: string; onEdit?: (item: Item) => void; onOpenFile?: (entry: FsEntry) => void }) {
  if (["agents", "search", "image", "review", "sleep", "compaction"].includes(item.kind)) return <StructuredItem item={item} cwd={cwd} onOpenFile={onOpenFile} />;
  if (item.kind === "user")
    return (
      <article className="message user-message" data-user-message="true" data-item-id={item.id}>
        <div className="avatar user-avatar">你</div>
        <div className="message-body">
          <div className="message-meta">
            你 <span>{itemTimestamp(item)}</span>
            {item.queueId && <span className="queued-message-label">待执行指令</span>}
            {isLastUser && (
              <button className="message-edit-button" disabled={!editable} onClick={() => onEdit?.(item)} title={editable ? "编辑并重新发送最近消息" : editUnavailableReason} aria-label="编辑并重新发送最近消息">
                <PencilLine size={14} />
              </button>
            )}
          </div>
          <div className="prose">
            <MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} />
          </div>
        </div>
      </article>
    );
  if (item.kind === "agent")
    return (
      <article className={`message agent-message ${isFinalAgentMessage(item) ? "final-agent-message" : "process-agent-message"}`}>
        <div className="avatar agent-avatar">
          <Code2 size={16} />
        </div>
        <div className="message-body">
          <div className="message-meta">
            Codex{" "}
            <span>{itemTimestamp(item)} · {isFinalAgentMessage(item) ? "最终回复" : item.status === "inProgress" ? "正在生成" : "执行过程"}</span>
          </div>
          <div className="prose">
            <MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} />
          </div>
        </div>
      </article>
    );
  if (item.kind === "system")
    return (
      <article className="timeline-error-card">
        <div className="timeline-error-icon"><CircleAlert size={16} /></div>
        <div className="timeline-error-copy">
          <div className="timeline-error-title">{item.title ?? "Codex 错误"}</div>
          <div className="prose"><MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} /></div>
        </div>
      </article>
    );
  if (item.kind === "reasoning")
    return (
      <details className="timeline-card reasoning-card">
        <summary>
          <Activity size={15} />
          <span>Reasoning</span>
          <ChevronDown size={15} className="chevron" />
        </summary>
        <div className="card-content muted-prose">
          <MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      </details>
    );
  if (item.kind === "command")
    return (
      <details className="timeline-card command-card">
        <summary>
          <Terminal size={15} />
          <span>{item.title ?? "Command"}</span>
          <span className="card-status">{item.status ?? "completed"}</span>
          <ChevronDown size={15} className="chevron" />
        </summary>
        {item.command && (
          <pre className="command-line">
            <code>{item.command}</code>
            <button
              className="mini-icon"
              aria-label="复制命令"
              onClick={() => navigator.clipboard?.writeText(item.command ?? "")}
            >
              <Copy size={13} />
            </button>
          </pre>
        )}
        {item.output && <pre className="command-output">{item.output}</pre>}
        {(item.exitCode !== undefined || item.durationMs !== undefined) && <div className="tool-metadata">{item.exitCode !== undefined ? `退出码 ${item.exitCode}` : ""} {item.durationMs !== undefined ? `耗时 ${(item.durationMs / 1000).toFixed(2)} 秒` : ""}</div>}
      </details>
    );
  if (item.kind === "file_change")
    return (
      <details className="timeline-card file-card">
        <summary>
          <FileCode2 size={15} />
          <span>{item.path ?? "文件修改"}</span>
          <span className="card-status">{item.status ?? "modified"}</span>
          <ChevronDown size={15} className="chevron" />
        </summary>
        {item.diff && <pre className="diff-preview">{item.diff}</pre>}
      </details>
    );
  if (item.kind === "plan")
    return (
      <details className="timeline-card plan-card">
        <summary>
          <ListChecks size={15} />
          <span>Plan</span>
          <ChevronDown size={15} className="chevron" />
        </summary>
        <div className="card-content"><MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} /></div>
      </details>
    );
  return (
    <details className="timeline-card">
      <summary>
        <Zap size={15} />
        <span>{item.title ?? "事件"}</span>
        <span className="card-status">{item.status}</span>
        <ChevronDown size={15} className="chevron" />
      </summary>
      <div className="card-content"><MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} /></div>
      {item.durationMs !== undefined && <div className="tool-metadata">耗时 {(item.durationMs / 1000).toFixed(2)} 秒</div>}
    </details>
  );
});

const ProcessGroup = memo(function ProcessGroup({
  items,
  cwd,
  open,
  onToggle,
  onOpenFile,
}: {
  items: Item[];
  cwd?: string;
  open: boolean;
  onToggle: () => void;
  onOpenFile?: (entry: FsEntry) => void;
}) {
  return (
    <section className={`process-group ${open ? "expanded" : "collapsed"}`}>
      <button
        className="process-group-toggle"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Activity size={15} />
        <span>{open ? "收起执行过程" : "展开执行过程"}</span>
        <small>{items.length} 项</small>
        <ChevronsDownUp size={15} className="process-group-icon" />
      </button>
      {open && (
        <div className="process-group-items">
          {items.map((item) => (
            <TimelineItem key={item.id} item={item} cwd={cwd} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </section>
  );
});

function TimelineSegments({
  items,
  cwd,
  isRunning,
  processExpanded,
  onToggleProcess,
  lastUserItem,
  canEditLastMessage,
  editUnavailableReason,
  onEdit,
  onOpenFile,
}: {
  items: Item[];
  cwd?: string;
  isRunning: boolean;
  processExpanded: boolean;
  onToggleProcess: () => void;
  lastUserItem?: Item;
  canEditLastMessage: boolean;
  editUnavailableReason: string;
  onEdit: (item: Item) => void;
  onOpenFile?: (entry: FsEntry) => void;
}) {
  const segments = useMemo(() => segmentTimeline(items), [items]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "process") {
          return <ProcessGroup key={`process-${index}`} items={segment.items} cwd={cwd} open={processExpanded} onToggle={onToggleProcess} onOpenFile={onOpenFile} />;
        }
        return segment.items.map((item) => (
          <TimelineItem
            key={item.id}
            item={item}
            cwd={cwd}
            isLastUser={item.id === lastUserItem?.id}
            editable={item.id === lastUserItem?.id && !isRunning && canEditLastMessage}
            editUnavailableReason={isRunning ? "请先中止当前运行" : editUnavailableReason}
            onEdit={onEdit}
            onOpenFile={onOpenFile}
          />
        ));
      })}
    </>
  );
}

function ApprovalBar({
  request,
  onRespond,
}: {
  request: RequestItem;
  onRespond: (request: RequestItem, decision: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");
  if (request.kind === "user_input" && request.questions?.length) {
    return (
      <section className="approval-bar question-bar">
        <div className="approval-icon">
          <MessageSquare size={18} />
        </div>
        <div className="approval-copy">
          <strong>{request.title}</strong>
          {request.questions.map((question) => (
            <div className="question-block" key={question.id}>
              <p>{question.question}</p>
              {question.options?.length ? (
                <div className="question-options">
                  {question.options.map((option) => (
                    <button
                      className={
                        answers[question.id] === option.label ? "selected" : ""
                      }
                      key={option.label}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: option.label,
                        }))
                      }
                    >
                      {answers[question.id] === option.label && (
                        <Check size={13} />
                      )}
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  className="question-input"
                  type={question.isSecret ? "password" : "text"}
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                  placeholder="输入你的回答"
                />
              )}
            </div>
          ))}
          {request.questions.length > 1 && (
            <input
              className="question-input"
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              placeholder="补充说明（可选）"
            />
          )}
        </div>
        <div className="approval-actions">
          <button
            className="secondary-button"
            onClick={() => onRespond(request, "skip")}
          >
            <X size={15} />
            跳过
          </button>
          <button
            className="primary-button"
            onClick={() =>
              onRespond(
                { ...request, detail: JSON.stringify({ answers, freeText }) },
                "answer",
              )
            }
          >
            <Check size={15} />
            提交
          </button>
        </div>
      </section>
    );
  }
  if (request.kind === "tool_call") {
    return (
      <section className="approval-bar">
        <div className="approval-icon"><Zap size={18} /></div>
        <div className="approval-copy">
          <strong>{request.title}</strong>
          <p>{request.detail ?? request.tool ?? "未配置的动态工具"}</p>
          {request.arguments !== undefined && <pre className="request-arguments">{JSON.stringify(request.arguments, null, 2)}</pre>}
          <small>此控制台未注册该动态工具。忽略后 Codex 会继续处理当前消息。</small>
        </div>
        <div className="approval-actions">
          <button className="secondary-button" onClick={() => onRespond(request, "unsupported")}>
            <X size={15} />
            忽略并继续
          </button>
        </div>
      </section>
    );
  }
  if (request.kind === "elicitation") {
    return (
      <section className="approval-bar">
        <div className="approval-copy">
          <strong>{request.title}</strong><p>{request.detail}</p>
          {request.url ? <a href={request.url} target="_blank" rel="noreferrer">打开授权页面</a> : <>
            <pre className="request-arguments">{JSON.stringify(request.requestedSchema, null, 2)}</pre>
            <textarea aria-label="MCP 表单 JSON" value={freeText} onChange={(event) => setFreeText(event.target.value)} placeholder="输入符合上方 Schema 的 JSON" />
          </>}
        </div>
        <div className="approval-actions">
          <button className="secondary-button" onClick={() => onRespond(request, "decline")}>拒绝</button>
          <button className="primary-button" onClick={() => onRespond({ ...request, detail: request.url ? "null" : freeText || "{}" }, "accept")}>提交</button>
        </div>
      </section>
    );
  }
  return (
    <section className="approval-bar">
      <div className="approval-icon">
        <ShieldAlert size={18} />
      </div>
      <div className="approval-copy">
        <strong>{request.title}</strong>
        <p>{request.detail ?? "Codex 正在等待你的确认"}</p>
        {request.command && <code>{request.command}</code>}
        {request.cwd && <small>{request.cwd}</small>}
        {request.permissions && <pre className="request-arguments">{JSON.stringify(request.permissions, null, 2)}</pre>}
      </div>
      <div className="approval-actions">
        <button
          className="secondary-button"
          onClick={() => onRespond(request, "decline")}
        >
          <X size={15} />
          拒绝
        </button>
        <button
          className="primary-button"
          onClick={() => onRespond(request, "accept")}
        >
          <Check size={15} />
          允许
        </button>
      </div>
    </section>
  );
}

function ContextPanel({
  snapshot,
  goalControls,
  tab,
  setTab,
  onOpenFile,
  onClose,
  onCollapse,
  queue,
  onQueueUpdate,
  active,
}: {
  snapshot: Snapshot | null;
  goalControls: GoalControls;
  tab: string;
  setTab: (tab: string) => void;
  onOpenFile: (entry: FsEntry) => void;
  onClose?: () => void;
  onCollapse?: () => void;
  queue: QueueEntry[];
  onQueueUpdate: (queue: QueueEntry[]) => void;
  active: boolean;
}) {
  return (
    <aside className="context-panel">
      <div className="context-head">
        <div>
          <span className="eyebrow">INSPECT</span>
          <h3>线程上下文</h3>
        </div>
        <div className="context-head-actions">
          {onCollapse && <button className="icon-button desktop-only" onClick={onCollapse} aria-label="收起上下文侧栏" title="收起上下文侧栏"><PanelRightClose size={18} /></button>}
          {onClose && <button className="icon-button mobile-only" onClick={onClose} aria-label="关闭上下文"><X size={18} /></button>}
        </div>
      </div>
      <div className="context-tabs">
        {([
          ["goal", "Goal", Target],
          ["plan", "Plan", ListChecks],
          ["diff", "Diff", GitBranch],
          ["files", "Files", Folder],
          ["terminal", "命令", Terminal],
          ["usage", "Usage", Activity],
          ["queue", "队列", ListChecks],
          ["status", "状态", Cpu],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={String(key)}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(String(key))}
          >
            <Icon size={14} />
            {label as string}
          </button>
        ))}
      </div>
      <div
        className={`context-content ${tab === "files" ? "files-context" : ""} ${tab === "terminal" ? "terminal-context" : ""}`}
      >
        {tab === "goal" && <GoalPanel threadId={snapshot?.thread.id} controls={goalControls} />}
        {tab === "plan" && (
          <div className="context-block">
            <div className="context-title">
              <ListChecks size={15} />
              执行计划
            </div>
            {snapshot?.plan?.length ? (
              snapshot.plan.map((step, i) => (
                <div className="plan-step" key={i}>
                  <span
                    className={
                      step.completed ? "step-check completed" : "step-check"
                    }
                  >
                    {step.completed && <Check size={11} />}
                  </span>
                  <span>{step.text}</span>
                </div>
              ))
            ) : (
              <div className="empty-context">Codex 尚未生成计划</div>
            )}
          </div>
        )}
        {tab === "diff" && (
          <div className="context-block">
            <div className="context-title">
              <GitBranch size={15} />
              最新 Diff
            </div>
            {snapshot?.diff ? (
              <pre className="context-diff">{snapshot.diff}</pre>
            ) : (
              <div className="empty-context">暂无 Diff</div>
            )}
          </div>
        )}
        {tab === "files" && (
          <WorkspaceFiles
            rootPath={snapshot?.thread.cwd}
            changedFiles={snapshot?.changedFiles}
            onOpenFile={onOpenFile}
          />
        )}
        {tab === "usage" && <UsagePanel snapshot={snapshot} queueLength={queue.length} api={api} />}
        {tab === "queue" && <QueuePanel threadId={snapshot?.thread.id} queue={queue} api={api} onUpdate={onQueueUpdate} />}
        {tab === "status" && active && <RuntimeStatusPanel threadId={snapshot?.thread.id} api={api} />}
        <div className={`command-panel-host ${tab === "terminal" ? "active" : ""}`}>
          <CommandPanel cwd={snapshot?.thread.cwd} />
        </div>
      </div>
    </aside>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadQuery, setThreadQuery] = useState("");
  const [archivedThreads, setArchivedThreads] = useState(false);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const threadListGeneration = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedArchived, setSelectedArchived] = useState(false);
  const goalControls = useGoal(selected, authenticated, api);
  const goalControlsRef = useRef(goalControls);
  goalControlsRef.current = goalControls;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [desktopLayout, setDesktopLayout] = useState(() => window.matchMedia("(min-width: 1121px)").matches);
  const [contextTab, setContextTab] = useState("plan");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(() => storedBoolean("codex-console-left-sidebar-collapsed"));
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(() => storedBoolean("codex-console-right-sidebar-collapsed"));
  const [connection, setConnection] = useState("connecting");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [editingLastMessage, setEditingLastMessage] = useState<{ itemId: string; originalText: string } | null>(null);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewEntry, setPreviewEntry] = useState<FsEntry | null>(null);
  const [queuedTurns, setQueuedTurns] = useState<QueueEntry[]>([]);
  const [executionSettings, setExecutionSettings] = useState<Record<string, ExecutionSettings>>(() => {
    try { const value = JSON.parse(localStorage.getItem("codex-console-execution-settings") ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const [threadActionsOpen, setThreadActionsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState(() => localStorage.getItem("codex-console-default-model") ?? "");
  const [threadModels, setThreadModels] = useState<Record<string, string>>(storedThreadModels);
  const [attachments, setAttachments] = useState<UploadAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedThreadRef = useRef<string | null>(null);
  const selectedThreadRef = useRef(selected);
  selectedThreadRef.current = selected;
  const applyEventRef = useRef<(event: TimelineEvent) => void>(() => {});
  const pendingSendRef = useRef<{ threadId: string; text: string; editing: typeof editingLastMessage } | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<UploadAttachment[]>([]);
  const hadStoredDefaultModel = useRef(localStorage.getItem("codex-console-default-model") !== null);
  const freshThreadRef = useRef<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [messageNavigation, setMessageNavigation] = useState({ index: 0, count: 0 });
  const [processExpanded, setProcessExpanded] = useState(true);
  const [visibleStart, setVisibleStart] = useState(0);
  const selectedModel = selected ? threadModels[selected] ?? defaultModel : defaultModel;
  const turnIsActive = isTurnActiveStatus(snapshot?.thread.status);
  const trimTimelineRef = useRef(true);
  const pendingPrependHeightRef = useRef<number | null>(null);
  const clearAttachments = useCallback(() => {
    setAttachments((items) => {
      for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }, []);
  const updateQueue = useCallback((queue: QueueEntry[]) => {
    setQueuedTurns(queue);
    setSnapshot((current) => current ? { ...current, items: current.items.flatMap((item) => {
      if (!item.queueId) return [item];
      const entry = queue.find((entry) => entry.id === item.queueId);
      return entry ? [{ ...item, text: entry.text || item.text }] : [];
    }) } : current);
  }, []);
  const appendTimelineError = useCallback((message: string, turnId?: string, markFailed = true) => {
    setError(message);
    setSnapshot((current) => {
      if (!current) return current;
      const existing = current.items.some((item) => item.kind === "system" && item.text === message);
      const items = existing
        ? current.items
        : [...current.items, { id: `codex-error-${turnId ?? createCommandId()}`, kind: "system" as const, createdAt: new Date().toISOString(), title: "Codex 错误", text: message, status: "failed" }];
      const thread = markFailed
        ? { ...current.thread, status: "failed" as const, activeTurnId: undefined, canInterrupt: false, activitySource: undefined }
        : current.thread;
      return { ...current, items, thread };
    });
  }, []);
  const beginEditLastMessage = useCallback((item: Item) => {
    if (isTurnActiveStatus(snapshot?.thread.status)) {
      setError("请先中止当前运行，再编辑最近消息");
      return;
    }
    const text = item.text ?? "";
    clearAttachments();
    setEditingLastMessage({ itemId: item.id, originalText: text });
    setInput(text);
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(text.length, text.length); });
  }, [snapshot?.thread.status, clearAttachments]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codex-console-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("codex-console-default-model", defaultModel);
  }, [defaultModel]);
  useEffect(() => {
    localStorage.setItem("codex-console-thread-models", JSON.stringify(threadModels));
  }, [threadModels]);
  useEffect(() => {
    localStorage.setItem("codex-console-left-sidebar-collapsed", String(leftSidebarCollapsed));
  }, [leftSidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem("codex-console-right-sidebar-collapsed", String(rightSidebarCollapsed));
  }, [rightSidebarCollapsed]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    setProcessExpanded(turnIsActive && (snapshot?.items.length ?? 0) <= TIMELINE_MAX_ITEMS);
  }, [selected, turnIsActive, snapshot?.items.length]);
  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  const updateMessageNavigation = useCallback(() => {
    const container = timelineRef.current;
    if (!container) return;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-user-message='true']"));
    if (nodes.length === 0) {
      setMessageNavigation((current) => current.count === 0 ? current : { index: 0, count: 0 });
      return;
    }
    const anchor = container.getBoundingClientRect().top + 32;
    let index = 0;
    nodes.forEach((node, candidate) => {
      if (node.getBoundingClientRect().top <= anchor) index = candidate;
    });
    setMessageNavigation((current) => current.index === index && current.count === nodes.length ? current : { index, count: nodes.length });
  }, []);

  const cancelEntryScroll = useThreadEntryScroll({
    selected, renderedThreadId: snapshot?.thread.id, itemCount: snapshot?.items.length ?? 0,
    visibleStart, initialCount: INITIAL_TIMELINE_ITEMS, setVisibleStart,
    containerRef: timelineRef, contentRef: timelineContentRef,
    reset: () => { trimTimelineRef.current = true; pendingPrependHeightRef.current = null; setAutoFollow(true); },
    positioned: () => { setAutoFollow(true); updateMessageNavigation(); },
  });
  const navigateUserMessage = useCallback((direction: -1 | 1) => {
    const container = timelineRef.current;
    if (!container) return;
    cancelEntryScroll();
    const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-user-message='true']"));
    if (nodes.length === 0) return;
    const targetIndex = Math.max(0, Math.min(nodes.length - 1, messageNavigation.index + direction));
    const target = nodes[targetIndex];
    if (!target) return;
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = container.scrollTop + target.getBoundingClientRect().top - containerTop - 18;
    setAutoFollow(false);
    setMessageNavigation({ index: targetIndex, count: nodes.length });
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }, [messageNavigation.index]);

  const loadThreads = useCallback(async (cursor?: string) => {
    const generation = ++threadListGeneration.current;
    const params = new URLSearchParams({ page: "true", archived: String(archivedThreads), search: threadQuery });
    if (cursor) params.set("cursor", cursor);
    const response = await api<Thread[] | { threads: Thread[]; nextCursor: string | null }>(`/api/threads?${params}`);
    if (generation !== threadListGeneration.current) return;
    const value = Array.isArray(response) ? response : response.threads;
    setThreads((previous) => cursor ? [...previous, ...value.filter((entry) => !previous.some((thread) => thread.id === entry.id))] : value);
    setThreadCursor(Array.isArray(response) ? null : response.nextCursor);
    if (!selectedThreadRef.current && value[0] && !archivedThreads) setSelected(value[0].id);
  }, [threadQuery, archivedThreads]);
  useEffect(() => {
    api<{ authenticated: boolean }>("/api/auth/me")
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const timer = setTimeout(() => { void loadThreads().catch((e) => setError(e.message)); }, 200);
    return () => { clearTimeout(timer); threadListGeneration.current += 1; };
  }, [authenticated, loadThreads]);
  useEffect(() => { localStorage.setItem("codex-console-execution-settings", JSON.stringify(executionSettings)); }, [executionSettings]);
  useEffect(() => { const media = window.matchMedia("(min-width: 1121px)"); const change = () => setDesktopLayout(media.matches); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  useEffect(() => {
    const open = (event: Event) => { const id = (event as CustomEvent<unknown>).detail; if (typeof id === "string") { setArchivedThreads(false); setSelected(id); } };
    window.addEventListener("codex-open-thread", open); return () => window.removeEventListener("codex-open-thread", open);
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    api<ModelOption[]>("/api/models")
      .then((value) => {
        setModels(value);
        if (!hadStoredDefaultModel.current) {
          const defaultEntry = value.find((entry) => entry.isDefault);
          if (defaultEntry) setDefaultModel(defaultEntry.model);
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取模型列表"));
  }, [authenticated]);
  const addCustomModel = async (model: string, displayName?: string) => {
    const entry = await api<ModelOption>("/api/models/custom", {
      method: "POST",
      body: JSON.stringify({ model, displayName }),
    });
    setModels((current) => current.some((item) => item.model === entry.model) ? current : [...current, entry]);
  };
  const deleteCustomModel = async (model: string) => {
    await api<null>("/api/models/custom", {
      method: "DELETE",
      body: JSON.stringify({ model }),
    });
    setModels((current) => current.filter((entry) => !(entry.isCustom && entry.model === model)));
    setDefaultModel((current) => current === model ? "" : current);
    setThreadModels((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== model)));
  };
  const subscribe = useCallback((threadId: string) => {
    const current = wsRef.current;
    if (current?.readyState === WebSocket.OPEN && subscribedThreadRef.current !== threadId) {
      current.send(JSON.stringify({ type: "subscribe_thread", threadId }));
      subscribedThreadRef.current = threadId;
    }
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    let closed = false;
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = socket;
      subscribedThreadRef.current = null;
      socket.onopen = () => {
        if (closed) return;
        setConnection("live");
        if (selectedThreadRef.current) subscribe(selectedThreadRef.current);
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection("offline");
        setTimeout(connect, 1800);
      };
      socket.onerror = () => setConnection("offline");
      socket.onmessage = (message) => {
        const selected = selectedThreadRef.current;
        let event: Record<string, unknown>;
        try { event = JSON.parse(message.data) as Record<string, unknown>; }
        catch { setError("收到无效的服务器消息，请重新连接"); return; }
        if (!event || typeof event !== "object") return;
        if (event.type === "thread_snapshot") {
          const data = event.snapshot as Snapshot;
          if (!data?.thread || !Array.isArray(data.items)) { setError("线程数据格式无效，请重新加载"); return; }
          if (event.replacesThreadId === selected) {
            freshThreadRef.current = data.thread.id;
            selectedThreadRef.current = data.thread.id;
            subscribedThreadRef.current = data.thread.id;
            if (pendingSendRef.current) pendingSendRef.current = { ...pendingSendRef.current, threadId: data.thread.id, editing: null };
            setThreads((items) => [data.thread, ...items.filter((thread) => thread.id !== data.thread.id)]);
            setThreadModels((models) => models[selected!] ? { ...models, [data.thread.id]: models[selected!]! } : models);
            setSelected(data.thread.id);
            setError("旧格式线程不支持原地回退，已创建截至上一轮的重发分支；原线程保持不变。");
          } else if (data.thread.id !== selected) return;
          setSnapshot(data);
          if (data.goalState) goalControlsRef.current.receiveState(data.goalState, data.thread.id);
          setActiveTurnId(data.thread.activeTurnId ?? null);
          setRequests(data.pendingRequests ?? []);
          setConnection("live");
        } else if (event.type === "goal_state") {
          if (typeof event.threadId === "string" && event.state && typeof event.state === "object") goalControlsRef.current.receiveState(event.state as GoalState, event.threadId);
        } else if (event.type === "thread_activity") {
          const activity = event.activity as { threadId: string; status: Thread["status"]; activeTurnId?: string; canInterrupt?: boolean; activitySource?: Thread["activitySource"] };
          setThreads((items) => items.map((thread) => thread.id === activity.threadId ? { ...thread, ...activity } : thread));
          if (activity.threadId === selected) {
            setActiveTurnId(activity.activeTurnId ?? null);
            setSnapshot((current) => current ? { ...current, thread: { ...current.thread, ...activity } } : current);
          }
        } else if (event.type === "turn_queued") {
          if (event.threadId === selected && typeof event.queuedId === "string" && typeof event.text === "string") {
            setQueuedTurns((items) => items.some((item) => item.id === event.queuedId) ? items : [...items, { id: event.queuedId as string, text: event.text as string, attachments: [] }]);
            setSnapshot((current) => {
              if (!current) return current;
              const pending = current.items.find((item) => item.kind === "user" && item.id.startsWith("local-user-") && !item.queueId && (!event.text || item.text === event.text));
              return pending ? { ...current, items: current.items.map((item) => item.id === pending.id ? { ...item, queueId: event.queuedId as string } : item) } : current;
            });
            pendingSendRef.current = null;
          }
        } else if (event.type === "turn_dequeued") {
          if (event.threadId === selected && typeof event.queuedId === "string") {
              setQueuedTurns((items) => items.filter((item) => item.id !== event.queuedId));
              setSnapshot((current) => current ? { ...current, items: current.items.map((item) => item.queueId === event.queuedId ? { ...item, queueId: undefined } : item) } : current);
            }
        } else if (event.type === "turn_queue_state") {
          if (event.threadId === selected && Array.isArray(event.queue)) {
            updateQueue(
              event.queue.filter(
                (item): item is QueueEntry =>
                  Boolean(item) &&
                  typeof item === "object" &&
                  typeof (item as Record<string, unknown>).id === "string" &&
                  typeof (item as Record<string, unknown>).text === "string",
              ),
            );
          }
        } else if (event.type === "interrupt_requested") {
          if (event.threadId === selected) setError("已向当前 Codex 窗口发送中止请求");
        } else if (event.type === "server_request") {
          if (typeof event.threadId === "string" && event.threadId !== selected) return;
          const request = event.request as RequestItem;
          if (!request || request.id === undefined) return;
          setRequests((items) =>
            items.some((item) => item.id === request.id)
              ? items
              : [...items, request],
          );
        } else if (event.type === "thread_event") {
          const threadId =
            typeof event.threadId === "string" ? event.threadId : undefined;
          const inner = event.event as TimelineEvent;
          if (!threadId || threadId === selected) applyEventRef.current(inner);
        } else if (event.type === "server_unavailable") {
          setConnection("offline");
          setError("Codex 服务正在重连，请稍后重试");
        } else if (event.type === "error") {
          const message = String(
            (event.error as Record<string, unknown>)?.message ?? "操作失败",
          );
          if (!event.threadId || event.threadId === selected) {
            appendTimelineError(message, typeof event.turnId === "string" ? event.turnId : undefined);
            const pending = pendingSendRef.current;
            if (pending?.threadId === selected) {
              setInput(pending.text);
              setEditingLastMessage(event.error && (event.error as Record<string, unknown>).code === "retry_failed" ? null : pending.editing);
              pendingSendRef.current = null;
            }
          } else {
            setError(message);
          }
        }
      };
    };
    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, [authenticated, subscribe, appendTimelineError, updateQueue]);
  const applyEvent = (event: TimelineEvent) => {
    if (event.method === "thread/goal/updated" || event.method === "thread/goal/cleared") {
      if (selectedThreadRef.current) goalControlsRef.current.receiveEvent(event, selectedThreadRef.current);
      return;
    }
    const params = event.params ?? {};
    if (event.method === "thread/name/updated" && typeof params.threadName === "string") {
      setThreads((threads) => threads.map((thread) => thread.id === selectedThreadRef.current ? { ...thread, title: params.threadName as string } : thread));
      setSnapshot((current) => current ? { ...current, thread: { ...current.thread, title: params.threadName as string } } : current);
      return;
    }
    if (event.method === "thread/settings/updated") {
      setSnapshot((current) => current ? { ...current, thread: { ...current.thread, runtimeSettings: runtimeSettingsFromRaw(params.threadSettings) } } : current);
      return;
    }
    if (event.method === "model/rerouted") {
      setSnapshot((current) => current ? { ...current, thread: { ...current.thread, runtimeSettings: { ...current.thread.runtimeSettings, model: typeof params.toModel === "string" ? params.toModel : undefined, reroutedFrom: typeof params.fromModel === "string" ? params.fromModel : undefined, rerouteReason: typeof params.reason === "string" ? params.reason : undefined } } } : current);
      return;
    }
    if (event.method === "thread/compacted") { setSnapshot((current) => current ? { ...current, compaction: "completed" } : current); return; }
    const eventCreatedAt = event.receivedAt ?? new Date().toISOString();
    const turnObject =
      params.turn && typeof params.turn === "object"
        ? (params.turn as Record<string, unknown>)
        : undefined;
    const eventTurnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof turnObject?.id === "string"
        ? turnObject.id
        : undefined;
    if (event.method === "error" || event.method === "thread/realtime/error") {
      const message = codexErrorText(params);
      const willRetry = params.willRetry === true;
      appendTimelineError(message, eventTurnId, !willRetry);
      setActiveTurnId((current) => willRetry ? current : eventTurnId && current && eventTurnId !== current ? current : null);
      return;
    }
    if (event.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        setRequests((items) => items.filter((item) => item.id !== requestId));
      }
      return;
    }
    if (event.method === "configWarning" || event.method === "deprecationNotice") {
      setError(typeof params.message === "string" ? params.message : "Codex 报告了配置或兼容性警告");
      return;
    }
    if (event.method === "server/exit") {
      setConnection("offline");
      appendTimelineError("Codex app-server 已退出，请重新连接或重试发送");
      setActiveTurnId(null);
      return;
    }
    if (event.method === "turn/started")
      { setActiveTurnId(eventTurnId ?? null); pendingSendRef.current = null; }
    if (event.method === "turn/completed" || event.method === "turn/interrupted" || event.method === "turn/interrupt")
      setActiveTurnId((current) => eventTurnId && current && eventTurnId !== current ? current : null);
    if (event.method === "turn/completed") {
      setRequests([]);
      const terminalStatus = typeof turnObject?.status === "string" ? turnObject.status : "completed";
      if (terminalStatus === "failed" || terminalStatus === "systemError") {
        appendTimelineError(codexErrorText({ error: turnObject?.error }), eventTurnId);
      }
    }
    setSnapshot((current) => {
      if (!current) return current;
      const currentTurnId = current.thread.activeTurnId ?? activeTurnId ?? undefined;
      const isTerminalTurnEvent = event.method === "turn/completed" || event.method === "turn/interrupted" || event.method === "turn/interrupt";
      // Ignore a late completion for an older turn so it cannot make a newer
      // queued turn appear idle.
      if (isTerminalTurnEvent && eventTurnId && currentTurnId && eventTurnId !== currentTurnId) return current;
      let items = [...current.items];
      let changedFiles = [...(current.changedFiles ?? [])];
      let diff = current.diff;
      let plan = current.plan;
      let tokenUsage = current.tokenUsage;
      const itemId = String(
        params.itemId ?? params.id ?? `event-${Date.now()}`,
      );
      if (event.method === "item/agentMessage/delta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index]!,
            text: `${items[index]!.text ?? ""}${String(params.delta ?? params.text ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "agent",
            createdAt: eventCreatedAt,
            text: String(params.delta ?? params.text ?? ""),
          });
      } else if (
        event.method === "item/reasoning/summaryTextDelta" ||
        event.method === "item/reasoning/textDelta"
      ) {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index]!,
            text: `${items[index]!.text ?? ""}${String(params.delta ?? params.text ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "reasoning",
            createdAt: eventCreatedAt,
            title: "Reasoning",
            text: String(params.delta ?? params.text ?? ""),
          });
      } else if (event.method === "item/plan/delta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0) items[index] = { ...items[index]!, text: `${items[index]!.text ?? ""}${String(params.delta ?? "")}` };
        else items.push({ id: itemId, kind: "plan", createdAt: eventCreatedAt, title: "Plan", status: "inProgress", text: String(params.delta ?? "") });
      } else if (event.method === "item/commandExecution/outputDelta" || event.method === "command/exec/outputDelta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index]!,
            output: `${items[index]!.output ?? ""}${String(params.delta ?? params.output ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "command",
            createdAt: eventCreatedAt,
            title: "Command",
            status: "inProgress",
            output: String(params.delta ?? params.output ?? ""),
          });
      } else if (event.method === "item/fileChange/outputDelta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index]!,
            diff: `${items[index]!.diff ?? ""}${String(params.delta ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "file_change",
            createdAt: eventCreatedAt,
            title: "File change",
            status: "inProgress",
            diff: String(params.delta ?? ""),
          });
      } else if (
        (event.method === "item/started" || event.method === "item/completed") &&
        params.item &&
        typeof params.item === "object"
      ) {
        const raw = params.item as Record<string, unknown>;
        const rawType = String(raw.type ?? "unknown");
        const changes = Array.isArray(raw.changes)
          ? raw.changes.filter(
              (change): change is Record<string, unknown> =>
                Boolean(change) && typeof change === "object",
            )
          : [];
        const summary = Array.isArray(raw.summary)
          ? raw.summary.filter((value) => typeof value === "string").join("\n")
          : "";
        const mapped: Item = {
          id: String(raw.id ?? itemId),
          createdAt: eventCreatedAt,
          kind: rawType === "agentMessage"
            ? "agent"
            : rawType === "reasoning"
              ? "reasoning"
              : rawType === "commandExecution"
                ? "command"
                : rawType === "fileChange"
                  ? "file_change"
                  : rawType === "plan"
                    ? "plan"
                    : rawType.toLowerCase().includes("mcp") || rawType === "dynamicToolCall" || rawType === "functionCallOutput"
                      ? "mcp"
                      : rawType === "userMessage"
                        ? "user"
                        : "unknown",
          title: rawType === "commandExecution" ? "Command" : rawType === "fileChange" ? `${changes.length || 1} file change${changes.length === 1 ? "" : "s"}` : rawType === "reasoning" ? "Reasoning" : typeof raw.tool === "string" ? raw.tool : typeof raw.name === "string" ? raw.name : rawType,
          text: (textFromRawItem(raw) ?? summary) || undefined,
          command: typeof raw.command === "string" ? raw.command : undefined,
          output:
            typeof raw.aggregatedOutput === "string"
              ? raw.aggregatedOutput
              : undefined,
          path: typeof changes[0]?.path === "string" ? changes[0].path : undefined,
          diff: changes.map((change) => typeof change.diff === "string" ? change.diff : "").filter(Boolean).join("\n") || undefined,
          status: typeof raw.phase === "string"
            ? raw.phase
            : typeof raw.status === "string"
              ? raw.status
              : event.method === "item/started"
                ? "inProgress"
                : undefined,
        };
        Object.assign(mapped, structuredItem(raw) ?? {});
        if (typeof raw.path === "string" || typeof raw.savedPath === "string") mapped.path = String(raw.savedPath ?? raw.path);
        if (typeof raw.durationMs === "number") mapped.durationMs = raw.durationMs;
        if (typeof raw.exitCode === "number") mapped.exitCode = raw.exitCode;
        if (mapped.kind === "compaction") { mapped.status = event.method === "item/completed" ? "completed" : "inProgress"; mapped.text = event.method === "item/completed" ? "上下文压缩完成" : "正在压缩上下文"; }
        const mergedItems = mergeTimelineItem(items, mapped);
        items = mergedItems;
        for (const change of changes) {
          if (typeof change.path !== "string") continue;
          const existing = changedFiles.find((file) => file.path === change.path);
          const status = changeStatusFromRaw(change.kind) ?? mapped.status;
          if (existing) existing.status = status;
          else changedFiles.push({ path: change.path, status });
        }
        if (mapped.diff) diff = mapped.diff;
      } else if (event.method === "turn/diff/updated") {
        if (typeof params.diff === "string") diff = params.diff;
      } else if (event.method === "turn/plan/updated") {
        plan = planFromRaw(params.plan);
      } else if (event.method === "thread/tokenUsage/updated") {
        const usage = params.tokenUsage;
        tokenUsage = tokenUsageFromRaw(usage) ?? tokenUsage;
      }
      const thread = { ...current.thread };
      if (event.method === "thread/status/changed") {
        const rawStatusObject = params.status && typeof params.status === "object" ? params.status as Record<string, unknown> : undefined;
        const activeFlags = Array.isArray(rawStatusObject?.activeFlags) ? rawStatusObject.activeFlags : [];
        const rawStatus = typeof params.status === "string" ? params.status : rawStatusObject ? String(rawStatusObject.type ?? "") : "";
        const statusWithFlags = rawStatus === "active" && activeFlags.includes("waitingOnApproval") ? "waiting_approval" : rawStatus === "active" && activeFlags.includes("waitingOnUserInput") ? "waiting_input" : rawStatus;
        const nextStatus = statusWithFlags === "active" ? "running" : statusWithFlags === "idle" || statusWithFlags === "notLoaded" ? "idle" : statusWithFlags.includes("approval") ? "waiting_approval" : statusWithFlags.includes("userInput") ? "waiting_input" : statusWithFlags === "systemError" ? "failed" : statusWithFlags ? statusWithFlags as Thread["status"] : thread.status;
        // app-server emits idle immediately before turn/completed. Keep the
        // active state until that terminal event arrives.
        if (!(nextStatus === "idle" && currentTurnId)) thread.status = nextStatus;
      }
      if (event.method === "turn/started") {
        thread.status = "running";
        thread.activeTurnId = eventTurnId;
        thread.canInterrupt = true;
        thread.activitySource = "console";
      }
      if (event.method === "turn/completed") {
        const terminalStatus = typeof turnObject?.status === "string" ? turnObject.status : "completed";
        thread.status = terminalStatus === "interrupted" ? "interrupted" : terminalStatus === "failed" || terminalStatus === "systemError" ? "failed" : "completed";
        thread.activeTurnId = undefined;
        thread.canInterrupt = false;
        thread.activitySource = undefined;
        const finalAgent = [...items].reverse().find((item) => item.kind === "agent");
        if (terminalStatus === "completed" && finalAgent && (!finalAgent.status || finalAgent.status === "inProgress")) {
          items = items.map((item) => item.id === finalAgent.id ? { ...item, status: "final_answer" } : item);
        }
      }
      if (event.method === "turn/interrupted" || event.method === "turn/interrupt") {
        thread.status = "interrupted";
        thread.activeTurnId = undefined;
        thread.canInterrupt = false;
        thread.activitySource = undefined;
      }
      const compaction = (event.method === "item/started" || event.method === "item/completed") && (params.item as { type?: string } | undefined)?.type === "contextCompaction" ? (event.method === "item/completed" ? "completed" : "running") : event.method === "turn/completed" && current.compaction === "running" ? (thread.status === "completed" ? "completed" : "failed") : current.compaction;
      return { ...current, thread, items, changedFiles, diff, plan, tokenUsage, compaction };
    });
  };
  applyEventRef.current = applyEvent;
  useEffect(() => {
    if (!selected || !authenticated) return;
    setEditingLastMessage(null);
    setInput("");
    clearAttachments();
    setQueuedTurns([]);
    if (freshThreadRef.current === selected) {
      freshThreadRef.current = null;
      subscribe(selected);
      return;
    }
    setSnapshot(null);
    let cancelled = false;
    api<Snapshot>(`/api/threads/${encodeURIComponent(selected)}`)
      .then((value) => {
        if (cancelled || selectedThreadRef.current !== selected) return;
        setSnapshot(value);
        setRequests(value.pendingRequests ?? []);
        subscribe(selected);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selected, authenticated, subscribe, clearAttachments]);
  useEffect(() => {
    const frame = requestAnimationFrame(updateMessageNavigation);
    return () => cancelAnimationFrame(frame);
  }, [snapshot?.thread.id, snapshot?.items.length, updateMessageNavigation]);
  useEffect(() => {
    window.addEventListener("resize", updateMessageNavigation);
    return () => window.removeEventListener("resize", updateMessageNavigation);
  }, [updateMessageNavigation]);
  useLayoutEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    const previousHeight = pendingPrependHeightRef.current;
    if (previousHeight !== null) {
      pendingPrependHeightRef.current = null;
      container.scrollTop += container.scrollHeight - previousHeight;
      updateMessageNavigation();
    }
  }, [selected, snapshot?.thread.id, snapshot?.items.length, visibleStart, updateMessageNavigation]);
  const removeAttachment = (id: string) => {
    setAttachments((items) => {
      const removed = items.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return items.filter((item) => item.id !== id);
    });
  };
  const uploadFiles = async (fileList: FileList | readonly File[] | null) => {
    if (!fileList?.length || uploading) return;
    const files = Array.from(fileList);
    if (files.length + attachments.length > 8) {
      setError("每条消息最多添加 8 个附件");
      return;
    }
    const invalid = files.find((file) => file.size === 0 || file.size > 25 * 1024 * 1024);
    if (invalid) {
      setError(`${invalid.name} 为空或超过 25 MiB`);
      return;
    }
    setUploading(true);
    try {
      const uploaded = await Promise.all(files.map(async (file) => {
        const response = await fetch(
          `/api/uploads?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || "application/octet-stream")}`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message ?? `无法上传 ${file.name}`);
        const attachment = body.data as UploadAttachment;
        return {
          ...attachment,
          previewUrl: attachment.kind === "image" ? URL.createObjectURL(file) : undefined,
        };
      }));
      setAttachments((items) => [...items, ...uploaded]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "附件上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
  const send = async () => {
    const text = input.trim();
    if (
      (!text && attachments.length === 0) ||
      !selected ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    )
      return;
    if (isTurnActiveStatus(snapshot?.thread.status) && snapshot?.thread.activitySource !== "external" && !activeTurnId) {
      setError("当前 Turn 尚未报告 ID，请稍候再试");
      return;
    }
    if (editingLastMessage && isTurnActiveStatus(snapshot?.thread.status)) {
      setError("请先中止当前运行，再编辑并重新发送最近消息");
      return;
    }
    setBusy(true);
    setError("");
    pendingSendRef.current = { threadId: selected, text, editing: editingLastMessage };
    setInput("");
    const outgoingAttachments = attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
    const actionType = editingLastMessage
      ? "retry_last_turn"
      : isTurnActiveStatus(snapshot?.thread.status)
        ? snapshot?.thread.status !== "running" || snapshot?.thread.activitySource === "external"
          ? "queue_turn"
          : "steer_turn"
        : "start_turn";
    if (actionType === "retry_last_turn" && editingLastMessage) {
      setSnapshot((current) => {
        if (!current) return current;
        return {
          ...current,
          items: current.items.map((item) =>
            item.id === editingLastMessage.itemId
              ? { ...item, text }
              : item,
          ),
        };
      });
    } else {
      const optimisticItem = createOptimisticUserItem(
        text,
        outgoingAttachments.map((attachment) => attachment.name),
      );
      setSnapshot((current) => current
        ? { ...current, items: [...current.items, optimisticItem] }
        : current);
      if (autoFollow) {
        requestAnimationFrame(() =>
          timelineRef.current?.scrollTo({
            top: timelineRef.current.scrollHeight,
            behavior: "smooth",
          }),
        );
      }
    }
    wsRef.current.send(JSON.stringify({
      type: actionType,
      threadId: selected,
      turnId: activeTurnId,
      text,
      attachments: outgoingAttachments,
      model: selectedModel || undefined,
      ...(executionSettings[selected] ?? {}),
    }));
    clearAttachments();
    setEditingLastMessage(null);
    setBusy(false);
  };
  const createThread = async (options: {
    cwd: string;
    model?: string;
    sandbox?: string;
    approvalPolicy?: string;
  }) => {
    const value = await api<Snapshot>("/api/threads", {
      method: "POST",
      body: JSON.stringify(options),
    });
    setArchivedThreads(false);
    setSelectedArchived(false);
    freshThreadRef.current = value.thread.id;
    setSnapshot(value);
    setThreads((items) => [value.thread, ...items]);
    setSelected(value.thread.id);
    setDrawerOpen(false);
    setNewThreadOpen(false);
  };
  const respond = async (request: RequestItem, decision: string) => {
    let response: Record<string, unknown>;
    try { response = responseForRequest(request, decision); }
    catch { setError("请输入有效的 JSON 回答"); return; }
    if (wsRef.current?.readyState !== WebSocket.OPEN) { setError("连接已断开，请稍后重试"); return; }
    wsRef.current?.send(
      JSON.stringify({
        type: "respond_request",
        requestId: request.id,
        response,
      }),
    );
    setRequests((items) => items.filter((item) => item.id !== request.id));
  };
  const interrupt = () => {
    if (!selected || !isTurnActiveStatus(snapshot?.thread.status)) {
      return;
    }
    wsRef.current?.send(
      JSON.stringify({
        type: "interrupt_turn",
        threadId: selected,
        turnId: activeTurnId ?? "",
      }),
    );
  };
  if (authenticated === null)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" size={22} />
      </div>
    );
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  const currentThread =
    snapshot?.thread ?? threads.find((thread) => thread.id === selected);
  const currentModelLabel =
    models.find((entry) => entry.model === selectedModel)?.displayName ??
    (selectedModel || currentThread?.model || "Codex");
  const lastUserItem = snapshot ? [...snapshot.items].reverse().find((item) => item.kind === "user") : undefined;
  const timelineStart = snapshot
    ? trimTimelineRef.current
      ? Math.max(visibleStart, snapshot.items.length - TIMELINE_MAX_ITEMS)
      : Math.min(visibleStart, snapshot.items.length)
    : 0;
  const visibleTimelineItems = snapshot?.items.slice(timelineStart) ?? [];
  const openGoalPanel = () => {
    setContextTab("goal");
    if (window.matchMedia("(min-width: 1121px)").matches) setRightSidebarCollapsed(false);
    else setContextOpen(true);
  };
  const loadEarlierMessages = () => {
    if (!snapshot || timelineStart <= 0 || pendingPrependHeightRef.current !== null) return;
    cancelEntryScroll();
    const container = timelineRef.current;
    if (container) pendingPrependHeightRef.current = container.scrollHeight;
    trimTimelineRef.current = false;
    setAutoFollow(false);
    setVisibleStart(Math.max(0, timelineStart - TIMELINE_CHUNK_SIZE));
  };
  return (
    <div className={`app-shell ${leftSidebarCollapsed ? "left-collapsed" : ""} ${rightSidebarCollapsed ? "right-collapsed" : ""}`}>
      <ThreadDrawer
        threads={threads}
        selected={selected}
        onSelect={(id) => { setSelectedArchived(archivedThreads); setSelected(id); }}
        onCreate={() => setNewThreadOpen(true)}
        onSettings={() => { setSettingsOpen(true); setDrawerOpen(false); }}
        onCollapse={() => setLeftSidebarCollapsed(true)}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        query={threadQuery}
        onQuery={setThreadQuery}
        archived={archivedThreads}
        onArchived={setArchivedThreads}
        nextCursor={threadCursor}
        onMore={() => { if (threadCursor) void loadThreads(threadCursor).catch((reason) => setError(reason.message)); }}
      />
      <main className="main-column">
        <header className="topbar">
          {leftSidebarCollapsed && <button className="icon-button desktop-only" onClick={() => setLeftSidebarCollapsed(false)} aria-label="打开线程侧栏" title="打开线程侧栏"><PanelLeftOpen size={19} /></button>}
          <button
            className="icon-button mobile-only"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开线程列表"
          >
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <span className="eyebrow">WORKSPACE</span>
            <h2>{currentThread?.title ?? "选择一个线程"}</h2>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" disabled={!snapshot} onClick={() => setThreadActionsOpen(true)} aria-label="线程操作" title="重命名、分支和归档"><MoreHorizontal size={18} /></button>
            <button className="icon-button" disabled={!selected} onClick={openGoalPanel} aria-label="打开目标控制" title="目标模式"><Target size={18} /></button>
            <span className={`connection-label ${connection}`}>
              <span className="connection-dot" />
              {connection === "live"
                ? "已连接"
                : connection === "offline"
                  ? "重连中"
                  : "连接中"}
            </span>
            <button
              className="icon-button"
              onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              title={theme === "dark" ? "浅色主题" : "深色主题"}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="icon-button"
              onClick={() => {
                if (window.matchMedia("(min-width: 1121px)").matches) setRightSidebarCollapsed((value) => !value);
                else setContextOpen(true);
              }}
              aria-label="切换上下文侧栏"
              title="切换上下文侧栏"
            >
              <PanelRight size={18} />
            </button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="打开设置">
              <Settings size={18} />
            </button>
          </div>
        </header>
        <div className="thread-meta">
          <StatusPill status={currentThread?.status ?? "unknown"} />
          <span className="meta-divider" />
          <span title="Codex 当前运行模型">{snapshot?.thread.runtimeSettings?.model ?? snapshot?.thread.model ?? currentModelLabel}</span>
          {snapshot?.thread.runtimeSettings?.effort && <span>{snapshot.thread.runtimeSettings.effort}</span>}
          {snapshot?.thread.runtimeSettings?.mode && <span>{snapshot.thread.runtimeSettings.mode}</span>}
          <span className="meta-divider" />
          <span className="cwd-label">
            <Folder size={13} />
            {currentThread?.cwd ?? "本机工作区"}
          </span>
          <button
            className="meta-settings"
            onClick={() => {
              setContextTab("files");
              setContextOpen(true);
            }}
          >
            <Folder size={14} />
            文件
          </button>
        </div>
        {goalControls.state?.goal && <button className="goal-summary" onClick={openGoalPanel} aria-label="查看当前目标">
          <Target size={15} /><span className={`goal-status ${goalControls.state.goal.status}`}>{goalStatusLabels[goalControls.state.goal.status]}</span><span className="goal-summary-objective">{goalControls.state.goal.objective}</span>
        </button>}
        <div
          className="timeline"
          ref={timelineRef}
          tabIndex={0}
          onScroll={(event) => {
            const target = event.currentTarget;
            const following = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
            setAutoFollow(following);
            if (!following) trimTimelineRef.current = false;
            updateMessageNavigation();
          }}
        >
          <div className="timeline-content" ref={timelineContentRef}>
          {!snapshot && (
            <div className="loading-state">
              <LoaderCircle className="spin" size={19} />
              正在加载线程
            </div>
          )}
          {snapshot && (
            <>
              {timelineStart > 0 && (
                <button
                  className="load-earlier-button"
                  onClick={loadEarlierMessages}
                  disabled={pendingPrependHeightRef.current !== null}
                >
                  <ArrowUp size={14} />
                  加载更早消息
                  <small>还剩 {timelineStart} 条</small>
                </button>
              )}
              <TimelineSegments
                items={visibleTimelineItems}
                cwd={snapshot.thread.cwd}
                isRunning={turnIsActive}
                processExpanded={processExpanded}
                onToggleProcess={() => setProcessExpanded((value) => !value)}
                lastUserItem={lastUserItem}
                canEditLastMessage={snapshot.thread.canRetry === true}
                editUnavailableReason="该线程仍被另一个 Codex 窗口占用，请关闭原窗口或从本控制台打开后再编辑"
                onEdit={beginEditLastMessage}
                onOpenFile={setPreviewEntry}
              />
            </>
          )}
          {snapshot?.items.length === 0 && (
            <div className="empty-thread">
              <div className="empty-icon">
                <Code2 size={22} />
              </div>
              <h3>开始一个新的 Codex 任务</h3>
              <p>描述你想完成的工作，Codex 会在本机项目中执行。</p>
            </div>
          )}
          </div>
        </div>
        {messageNavigation.count > 1 && (
          <div className="message-nav-controls" aria-label="用户消息导航">
            <button
              onClick={() => navigateUserMessage(-1)}
              disabled={messageNavigation.index <= 0}
              title="定位到上一条用户消息"
              aria-label="定位到上一条用户消息"
            >
              <ArrowUp size={16} />
            </button>
            <span>{messageNavigation.index + 1}/{messageNavigation.count}</span>
            <button
              onClick={() => navigateUserMessage(1)}
              disabled={messageNavigation.index >= messageNavigation.count - 1}
              title="定位到下一条用户消息"
              aria-label="定位到下一条用户消息"
            >
              <ArrowDown size={16} />
            </button>
          </div>
        )}
        {!autoFollow && (
          <button
            className="jump-button"
            onClick={() =>
              timelineRef.current?.scrollTo({
                top: timelineRef.current.scrollHeight,
                behavior: "smooth",
              })
            }
          >
            <ArrowDown size={15} />
            回到最新
          </button>
        )}
        {requests[0] && (
          <ApprovalBar key={requests[0].id} request={requests[0]} onRespond={respond} />
        )}
        <div className="composer-wrap">
          <div className="composer">
            {editingLastMessage && (
              <div className="composer-edit-banner">
                <RotateCcw size={14} />
                <span>正在编辑最近一次消息。发送后会回退最后一个 Turn 并重新执行。</span>
                <button onClick={() => { setEditingLastMessage(null); setInput(""); }} aria-label="取消编辑"><X size={14} /></button>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="attachment-strip" aria-label="已添加附件">
                {attachments.map((attachment) => (
                  <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
                    {attachment.previewUrl ? (
                      <img src={attachment.previewUrl} alt="" />
                    ) : (
                      <span className="attachment-icon"><FileIcon size={16} /></span>
                    )}
                    <span className="attachment-copy">
                      <strong>{attachment.name}</strong>
                      <small>{attachment.size < 1024 * 1024 ? `${Math.ceil(attachment.size / 1024)} KiB` : `${(attachment.size / 1024 / 1024).toFixed(1)} MiB`}</small>
                    </span>
                    <button onClick={() => removeAttachment(attachment.id)} aria-label={`移除 ${attachment.name}`} title="移除附件"><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(event) => {
                const files = filesFromClipboard(event.clipboardData);
                if (files.length === 0) return;
                event.preventDefault();
                if (editingLastMessage) {
                  setError("编辑并重新发送最近消息时暂不支持添加附件");
                  return;
                }
                void uploadFiles(files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                editingLastMessage
                  ? "编辑最近一次消息并重新发送…"
                  : snapshot?.thread.status === "running" && snapshot.thread.activitySource === "external"
                    ? "另一个 Codex 窗口正在运行，发送后会自动排队…"
                    : isTurnActiveStatus(snapshot?.thread.status)
                    ? "追加指令，指导 Codex 继续工作…"
                  : "描述你想让 Codex 完成的工作…"
              }
              rows={1}
            />
            <div className="composer-toolbar">
              <div className="composer-hints">
                <input
                  ref={fileInputRef}
                  className="attachment-input"
                  type="file"
                  multiple
                  onChange={(event) => void uploadFiles(event.target.files)}
                />
                <button
                  className="tool-button"
                  aria-label="添加图片或文件"
                  title="添加图片或文件"
                  disabled={uploading || Boolean(editingLastMessage) || attachments.length >= 8}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={16} />}
                </button>
                <label className="composer-model-select" title="为下一条消息选择模型">
                  <Cpu size={14} />
                  <select
                    aria-label="消息模型"
                    value={selectedModel}
                    disabled={Boolean(editingLastMessage)}
                    onChange={(event) => {
                      if (!selected) return;
                      setThreadModels((current) => ({ ...current, [selected]: event.target.value }));
                      setExecutionSettings((current) => ({ ...current, [selected]: {} }));
                    }}
                  >
                    <option value="">Codex 默认</option>
                    {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
                  </select>
                </label>
                <ExecutionSettingsMenu
                  threadId={selected}
                  models={models}
                  model={selectedModel || snapshot?.thread.runtimeSettings?.model || snapshot?.thread.model || ""}
                  value={selected ? executionSettings[selected] ?? {} : {}}
                  disabled={!selected || Boolean(editingLastMessage)}
                  onChange={(value) => { if (selected) setExecutionSettings((current) => ({ ...current, [selected]: value })); }}
                />
                {queuedTurns.length > 0 && <button className="queue-count-button" onClick={() => { setContextTab("queue"); setRightSidebarCollapsed(false); setContextOpen(true); }}>{queuedTurns.length} 条指令排队中</button>}
                <span className="composer-shortcut">⌘ Enter 发送</span>
              </div>
              <div className="composer-actions">
                {isTurnActiveStatus(snapshot?.thread.status) && (
                  <button
                    className="stop-button"
                    onClick={interrupt}
                    aria-label="停止当前任务"
                    title={snapshot?.thread.activitySource === "external" ? "中止外部 Codex 任务；对应 Codex 进程可能退出" : "中止这次消息"}
                  >
                    <Square size={15} fill="currentColor" />
                  </button>
                )}
                <button
                  className="send-button"
                  disabled={(!input.trim() && attachments.length === 0) || busy || uploading}
                  onClick={() => void send()}
                  aria-label="发送"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
      <div className={`context-mobile ${contextOpen ? "open" : ""}`}>
        <ContextPanel
          snapshot={snapshot}
          goalControls={goalControls}
          queue={queuedTurns}
          onQueueUpdate={updateQueue}
          active={!desktopLayout && contextOpen}
          tab={contextTab}
          setTab={setContextTab}
          onOpenFile={setPreviewEntry}
          onClose={() => setContextOpen(false)}
        />
      </div>
      <aside className="context-desktop">
        <ContextPanel
          snapshot={snapshot}
          goalControls={goalControls}
          queue={queuedTurns}
          onQueueUpdate={updateQueue}
          active={desktopLayout && !rightSidebarCollapsed}
          tab={contextTab}
          setTab={setContextTab}
          onOpenFile={setPreviewEntry}
          onCollapse={() => setRightSidebarCollapsed(true)}
        />
      </aside>
      {threadActionsOpen && snapshot && <ThreadActions thread={snapshot.thread} archived={selectedArchived} onClose={() => setThreadActionsOpen(false)} onAction={async (action, name) => {
        const id = snapshot.thread.id;
        if (action === "fork") { const fork = await api<Snapshot>(`/api/threads/${encodeURIComponent(id)}/fork`, { method: "POST", body: "{}" }); setArchivedThreads(false); setSelectedArchived(false); setSelected(fork.thread.id); setSnapshot(fork); }
        else { await api(`/api/threads/${encodeURIComponent(id)}/${action}`, { method: action === "name" ? "PATCH" : "POST", body: JSON.stringify(action === "name" ? { name } : {}) }); if (action === "archive") { setSelected(null); setSnapshot(null); setThreads((threads) => threads.filter((thread) => thread.id !== id)); } if (action === "unarchive") { setArchivedThreads(false); setSelectedArchived(false); } if (action === "name") setSnapshot((current) => current?.thread.id === id ? { ...current, thread: { ...current.thread, title: name! } } : current); }
        await loadThreads();
      }} />}
      {newThreadOpen && (
        <NewThreadDialog
          initialPath={currentThread?.cwd}
          models={models}
          defaultModel={defaultModel}
          onClose={() => setNewThreadOpen(false)}
          onCreate={createThread}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          models={models}
          defaultModel={defaultModel}
          onThemeChange={setTheme}
          onDefaultModelChange={setDefaultModel}
          onAddCustomModel={addCustomModel}
          onDeleteCustomModel={deleteCustomModel}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {previewEntry && (
        <FilePreview
          entry={previewEntry}
          onClose={() => setPreviewEntry(null)}
        />
      )}
      {error && (
        <div className="toast-error">
          <CircleAlert size={16} />
          {error}
          <button onClick={() => setError("")} aria-label="关闭错误">
            <X size={15} />
          </button>
        </div>
      )}
      <button
        className="logout-float"
        onClick={async () => {
          await api("/api/auth/logout", { method: "POST" });
          setAuthenticated(false);
        }}
        aria-label="退出登录"
      >
        <LogOut size={15} />
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
