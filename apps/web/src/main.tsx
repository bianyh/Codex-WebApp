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
  PanelRight,
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
  Terminal,
  X,
  Zap,
} from "lucide-react";
import type {
  Item,
  ModelOption,
  RequestItem,
  Snapshot,
  ThemeMode,
  Thread,
  TimelineEvent,
  UploadAttachment,
} from "./types";
import { FilePreview, WorkspaceFiles, fileEntryFromPath, type FsEntry } from "./WorkspaceFiles";
import { resolveLocalFileHref } from "./fileLinks";
import { normalizeMarkdownMath } from "./markdown";
import { createOptimisticUserItem, mergeTimelineItem, textFromRawItem } from "./messageState";
import { NewThreadDialog } from "./NewThreadDialog";
import { SettingsDialog } from "./SettingsDialog";
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
  const [label, cls] = map[status] ?? map.unknown;
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

function ThreadDrawer({
  threads,
  selected,
  onSelect,
  onCreate,
  onSettings,
  open,
  onClose,
}: {
  threads: Thread[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = threads.filter((thread) =>
    `${thread.title} ${thread.cwd ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <aside className={`drawer ${open ? "open" : ""}`}>
      <div className="drawer-top">
        <div className="brand">
          <div className="brand-mark small">
            <Code2 size={16} />
          </div>
          <span>Codex Console</span>
        </div>
        <button
          className="icon-button mobile-only"
          onClick={onClose}
          aria-label="关闭侧栏"
        >
          <X size={18} />
        </button>
      </div>
      <button className="new-thread-button" onClick={onCreate}>
        <Plus size={17} />
        新建线程
      </button>
      <div className="search-box">
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索线程"
        />
      </div>
      <div className="drawer-section-label">
        <span>最近线程</span>
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
      </div>
      <div className="drawer-bottom">
        <button className="drawer-action">
          <Archive size={16} />
          归档
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
  if (item.kind === "user")
    return (
      <article className="message user-message" data-user-message="true" data-item-id={item.id}>
        <div className="avatar user-avatar">你</div>
        <div className="message-body">
          <div className="message-meta">
            你 <span>刚刚</span>
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
            <span>{isFinalAgentMessage(item) ? "最终回复" : item.status === "inProgress" ? "正在生成" : "执行过程"}</span>
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
        <ChevronDown size={15} className="chevron" />
      </summary>
      <div className="card-content"><MessageMarkdown text={item.text ?? ""} cwd={cwd} onOpenFile={onOpenFile} /></div>
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
  tab,
  setTab,
  onOpenFile,
  onClose,
}: {
  snapshot: Snapshot | null;
  tab: string;
  setTab: (tab: string) => void;
  onOpenFile: (entry: FsEntry) => void;
  onClose?: () => void;
}) {
  return (
    <aside className="context-panel">
      <div className="context-head">
        <div>
          <span className="eyebrow">INSPECT</span>
          <h3>线程上下文</h3>
        </div>
        {onClose && (
          <button
            className="icon-button mobile-only"
            onClick={onClose}
            aria-label="关闭上下文"
          >
            <X size={18} />
          </button>
        )}
      </div>
      <div className="context-tabs">
        {[
          ["plan", "Plan", ListChecks],
          ["diff", "Diff", GitBranch],
          ["files", "Files", Folder],
          ["usage", "Usage", Activity],
        ].map(([key, label, Icon]) => (
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
        className={`context-content ${tab === "files" ? "files-context" : ""}`}
      >
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
        {tab === "usage" && (
          <div className="context-block">
            <div className="context-title">
              <Activity size={15} />
              Token 用量
            </div>
            <div className="usage-total">
              {snapshot?.tokenUsage?.total?.toLocaleString() ?? "--"}
              <span>tokens</span>
            </div>
            <div className="usage-row">
              <span>输入</span>
              <strong>
                {snapshot?.tokenUsage?.input?.toLocaleString() ?? "--"}
              </strong>
            </div>
            <div className="usage-row">
              <span>输出</span>
              <strong>
                {snapshot?.tokenUsage?.output?.toLocaleString() ?? "--"}
              </strong>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextTab, setContextTab] = useState("plan");
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
  const [queuedTurns, setQueuedTurns] = useState<Array<{ id: string; text: string }>>([]);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState(() => localStorage.getItem("codex-console-default-model") ?? "");
  const [threadModels, setThreadModels] = useState<Record<string, string>>(storedThreadModels);
  const [attachments, setAttachments] = useState<UploadAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
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
  const pendingInitialScrollRef = useRef<string | null>(null);
  const pendingPrependHeightRef = useRef<number | null>(null);
  const clearAttachments = useCallback(() => {
    setAttachments((items) => {
      for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }, []);
  const appendTimelineError = useCallback((message: string, turnId?: string, markFailed = true) => {
    setError(message);
    setSnapshot((current) => {
      if (!current) return current;
      const existing = current.items.some((item) => item.kind === "system" && item.text === message);
      const items = existing
        ? current.items
        : [...current.items, { id: `codex-error-${turnId ?? crypto.randomUUID()}`, kind: "system" as const, title: "Codex 错误", text: message, status: "failed" }];
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
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    setProcessExpanded(turnIsActive && (snapshot?.items.length ?? 0) <= TIMELINE_MAX_ITEMS);
  }, [selected, turnIsActive, snapshot?.items.length]);
  useEffect(() => {
    if (!selected) return;
    trimTimelineRef.current = true;
    pendingInitialScrollRef.current = selected;
    pendingPrependHeightRef.current = null;
    setVisibleStart(0);
    setAutoFollow(true);
  }, [selected]);
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

  const navigateUserMessage = useCallback((direction: -1 | 1) => {
    const container = timelineRef.current;
    if (!container) return;
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

  const loadThreads = useCallback(async () => {
    const value = await api<Thread[]>("/api/threads");
    setThreads(value);
    if (!selected && value[0]) setSelected(value[0].id);
  }, [selected]);
  useEffect(() => {
    api<{ authenticated: boolean }>("/api/auth/me")
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (authenticated) loadThreads().catch((e) => setError(e.message));
  }, [authenticated, loadThreads]);
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
  const subscribe = useCallback((threadId: string) => {
    const current = wsRef.current;
    if (current?.readyState === WebSocket.OPEN)
      current.send(JSON.stringify({ type: "subscribe_thread", threadId }));
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    let closed = false;
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = socket;
      socket.onopen = () => {
        if (closed) return;
        setConnection("live");
        if (selected) subscribe(selected);
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection("offline");
        setTimeout(connect, 1800);
      };
      socket.onerror = () => setConnection("offline");
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as Record<string, unknown>;
        if (event.type === "thread_snapshot") {
          const data = event.snapshot as Snapshot;
          setSnapshot(data);
          setActiveTurnId(data.thread.activeTurnId ?? null);
          setRequests(data.pendingRequests ?? []);
          setConnection("live");
        } else if (event.type === "thread_activity") {
          const activity = event.activity as { threadId: string; status: Thread["status"]; activeTurnId?: string; canInterrupt?: boolean; activitySource?: Thread["activitySource"] };
          setThreads((items) => items.map((thread) => thread.id === activity.threadId ? { ...thread, ...activity } : thread));
          if (activity.threadId === selected) {
            setActiveTurnId(activity.activeTurnId ?? null);
            setSnapshot((current) => current ? { ...current, thread: { ...current.thread, ...activity } } : current);
          }
        } else if (event.type === "turn_queued") {
          if (event.threadId === selected && typeof event.queuedId === "string" && typeof event.text === "string") {
            setQueuedTurns((items) => items.some((item) => item.id === event.queuedId) ? items : [...items, { id: event.queuedId as string, text: event.text as string }]);
          }
        } else if (event.type === "turn_dequeued") {
          if (event.threadId === selected && typeof event.queuedId === "string") {
              setQueuedTurns((items) => items.filter((item) => item.id !== event.queuedId));
            }
        } else if (event.type === "turn_queue_state") {
          if (event.threadId === selected && Array.isArray(event.queue)) {
            setQueuedTurns(
              event.queue.filter(
                (item): item is { id: string; text: string } =>
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
          setRequests((items) =>
            items.some((item) => item.id === request.id)
              ? items
              : [...items, request],
          );
        } else if (event.type === "thread_event") {
          const threadId =
            typeof event.threadId === "string" ? event.threadId : undefined;
          const inner = event.event as TimelineEvent;
          if (threadId && threadId === selected) applyEvent(inner);
        } else if (event.type === "error") {
          const message = String(
            (event.error as Record<string, unknown>)?.message ?? "操作失败",
          );
          if (!event.threadId || event.threadId === selected) {
            appendTimelineError(message, typeof event.turnId === "string" ? event.turnId : undefined);
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
  }, [authenticated, selected, subscribe, appendTimelineError]);
  const applyEvent = (event: TimelineEvent) => {
    const params = event.params ?? {};
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
    if (event.method === "turn/started")
      setActiveTurnId(eventTurnId ?? null);
    if (event.method === "turn/completed" || event.method === "turn/interrupted" || event.method === "turn/interrupt")
      setActiveTurnId((current) => eventTurnId && current && eventTurnId !== current ? current : null);
    if (event.method === "turn/completed") {
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
      const items = [...current.items];
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
            ...items[index],
            text: `${items[index].text ?? ""}${String(params.delta ?? params.text ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "agent",
            text: String(params.delta ?? params.text ?? ""),
          });
      } else if (
        event.method === "item/reasoning/summaryTextDelta" ||
        event.method === "item/reasoning/textDelta"
      ) {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index],
            text: `${items[index].text ?? ""}${String(params.delta ?? params.text ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "reasoning",
            title: "Reasoning",
            text: String(params.delta ?? params.text ?? ""),
          });
      } else if (event.method === "item/plan/delta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0) items[index] = { ...items[index], text: `${items[index].text ?? ""}${String(params.delta ?? "")}` };
        else items.push({ id: itemId, kind: "plan", title: "Plan", status: "inProgress", text: String(params.delta ?? "") });
      } else if (event.method === "item/commandExecution/outputDelta" || event.method === "command/exec/outputDelta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index],
            output: `${items[index].output ?? ""}${String(params.delta ?? params.output ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "command",
            title: "Command",
            status: "inProgress",
            output: String(params.delta ?? params.output ?? ""),
          });
      } else if (event.method === "item/fileChange/outputDelta") {
        const index = items.findIndex((item) => item.id === itemId);
        if (index >= 0)
          items[index] = {
            ...items[index],
            diff: `${items[index].diff ?? ""}${String(params.delta ?? "")}`,
          };
        else
          items.push({
            id: itemId,
            kind: "file_change",
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
                    : rawType.toLowerCase().includes("mcp")
                      ? "mcp"
                      : rawType === "userMessage"
                        ? "user"
                        : "unknown",
          title: rawType === "commandExecution" ? "Command" : rawType === "fileChange" ? `${changes.length || 1} file change${changes.length === 1 ? "" : "s"}` : rawType === "reasoning" ? "Reasoning" : undefined,
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
        const mergedItems = mergeTimelineItem(items, mapped);
        items.splice(0, items.length, ...mergedItems);
        for (const change of changes) {
          if (typeof change.path !== "string") continue;
          const existing = changedFiles.find((file) => file.path === change.path);
          const status = typeof change.kind === "string" ? change.kind : mapped.status;
          if (existing) existing.status = status;
          else changedFiles.push({ path: change.path, status });
        }
        if (mapped.diff) diff = mapped.diff;
      } else if (event.method === "turn/diff/updated") {
        if (typeof params.diff === "string") diff = params.diff;
      } else if (event.method === "turn/plan/updated") {
        const rawPlan = Array.isArray(params.plan) ? params.plan : [];
        plan = rawPlan.map((step) => typeof step === "string" ? { text: step } : { text: String((step as Record<string, unknown>).text ?? ""), completed: Boolean((step as Record<string, unknown>).completed) });
      } else if (event.method === "thread/tokenUsage/updated") {
        const usage = params.tokenUsage;
        if (usage && typeof usage === "object") tokenUsage = usage as Snapshot["tokenUsage"];
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
      }
      if (event.method === "turn/interrupted" || event.method === "turn/interrupt") {
        thread.status = "interrupted";
        thread.activeTurnId = undefined;
        thread.canInterrupt = false;
        thread.activitySource = undefined;
      }
      return { ...current, thread, items, changedFiles, diff, plan, tokenUsage };
    });
  };
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
    api<Snapshot>(`/api/threads/${encodeURIComponent(selected)}`)
      .then((value) => {
        setSnapshot(value);
        setRequests(value.pendingRequests ?? []);
        subscribe(selected);
      })
      .catch((e) => setError(e.message));
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
    const threadId = snapshot?.thread.id;
    if (threadId && threadId === selected && pendingInitialScrollRef.current === threadId) {
      const start = Math.max(0, (snapshot?.items.length ?? 0) - INITIAL_TIMELINE_ITEMS);
      if (visibleStart !== start) {
        setVisibleStart(start);
        return;
      }
      pendingInitialScrollRef.current = null;
      container.scrollTop = container.scrollHeight;
      setAutoFollow(true);
      updateMessageNavigation();
    }
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
    setInput("");
    const outgoingAttachments = attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
    const actionType = editingLastMessage
      ? "retry_last_turn"
      : isTurnActiveStatus(snapshot?.thread.status)
        ? snapshot.thread.status !== "running" || snapshot.thread.activitySource === "external"
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
    freshThreadRef.current = value.thread.id;
    setSnapshot(value);
    setThreads((items) => [value.thread, ...items]);
    setSelected(value.thread.id);
    setDrawerOpen(false);
    setNewThreadOpen(false);
  };
  const respond = async (request: RequestItem, decision: string) => {
    let response: Record<string, unknown> = { decision };
    if (decision === "unsupported" && request.kind === "tool_call") {
      response = {
        success: false,
        contentItems: [{ type: "inputText", text: "该动态工具未在 Codex Console 中配置。请继续完成当前消息。" }],
      };
    }
    if (decision === "answer") {
      try {
        const parsed = JSON.parse(request.detail ?? "{}");
        const answers = parsed.answers as Record<string, string>;
        response = {
          answers: Object.fromEntries(
            Object.entries(answers).map(([key, value]) => [
              key,
              { answers: [value] },
            ]),
          ),
        };
      } catch {
        response = { answers: {} };
      }
    } else if (decision === "skip" && request.kind === "user_input")
      response = { answers: {} };
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
  const loadEarlierMessages = () => {
    if (!snapshot || timelineStart <= 0 || pendingPrependHeightRef.current !== null) return;
    const container = timelineRef.current;
    if (container) pendingPrependHeightRef.current = container.scrollHeight;
    trimTimelineRef.current = false;
    setAutoFollow(false);
    setVisibleStart(Math.max(0, timelineStart - TIMELINE_CHUNK_SIZE));
  };
  return (
    <div className="app-shell">
      <ThreadDrawer
        threads={threads}
        selected={selected}
        onSelect={setSelected}
        onCreate={() => setNewThreadOpen(true)}
        onSettings={() => { setSettingsOpen(true); setDrawerOpen(false); }}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <main className="main-column">
        <header className="topbar">
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
              onClick={() => setContextOpen(true)}
              aria-label="打开上下文"
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
          <span>{currentModelLabel}</span>
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
          <ApprovalBar request={requests[0]} onRespond={respond} />
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
                    disabled={snapshot?.thread.status === "running" && snapshot?.thread.activitySource !== "external"}
                    onChange={(event) => {
                      if (!selected) return;
                      setThreadModels((current) => ({ ...current, [selected]: event.target.value }));
                    }}
                  >
                    <option value="">Codex 默认</option>
                    {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
                  </select>
                </label>
                <span>{queuedTurns.length ? `${queuedTurns.length} 条指令排队中 · ` : ""}⌘ Enter 发送</span>
              </div>
              <div className="composer-actions">
                {isTurnActiveStatus(snapshot?.thread.status) && (
                  <button
                    className="stop-button"
                    onClick={interrupt}
                    aria-label="停止当前任务"
                    title={snapshot.thread.activitySource === "external" ? "中止外部 Codex 任务；对应 Codex 进程可能退出" : "中止这次消息"}
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
          tab={contextTab}
          setTab={setContextTab}
          onOpenFile={setPreviewEntry}
          onClose={() => setContextOpen(false)}
        />
      </div>
      <aside className="context-desktop">
        <ContextPanel
          snapshot={snapshot}
          tab={contextTab}
          setTab={setContextTab}
          onOpenFile={setPreviewEntry}
        />
      </aside>
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
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
