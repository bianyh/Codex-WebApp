import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMarkdownMath } from "./markdown";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  File,
  FileCode2,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Music,
  RefreshCw,
  X,
} from "lucide-react";

export type FsEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  kind:
    | "directory"
    | "text"
    | "markdown"
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "binary";
  size: number;
  modifiedAt: string;
  hidden: boolean;
};
type FsListing = {
  path: string;
  root: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
};
type TextContent = {
  path: string;
  name: string;
  kind: "text" | "markdown";
  size: number;
  modifiedAt: string;
  content: string;
};

function LineNumberedText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <div className="text-preview-shell" role="document" aria-label={`文本内容，共 ${lines.length} 行`}>
      <pre className="text-preview-lines" aria-hidden="true">
        {lines.map((_line, index) => (
          <span className="text-preview-line" key={index}>{index + 1}</span>
        ))}
      </pre>
      <pre className="text-preview">
        {lines.map((line, index) => (
          <span className="text-preview-line" key={index}>{line || "\u00a0"}</span>
        ))}
      </pre>
    </div>
  );
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "请求失败");
  return body.data as T;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error?.message ?? "请求失败");
  return value.data as T;
}

function FileIcon({ entry, size = 15 }: { entry: FsEntry; size?: number }) {
  if (entry.type === "directory") return <Folder size={size} />;
  if (entry.kind === "image") return <FileImage size={size} />;
  if (entry.kind === "video") return <Film size={size} />;
  if (entry.kind === "audio") return <Music size={size} />;
  if (entry.kind === "text" || entry.kind === "markdown")
    return <FileCode2 size={size} />;
  if (entry.kind === "pdf") return <FileText size={size} />;
  return <File size={size} />;
}

function humanSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / 1024 / 1024).toFixed(1)} MiB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function kindFromName(name: string): FsEntry["kind"] {
  const extension = name.includes(".") ? `.${name.split(".").pop()?.toLowerCase()}` : "";
  if ([".md", ".mdx"].includes(extension)) return "markdown";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"].includes(extension)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(extension)) return "audio";
  if (extension === ".pdf") return "pdf";
  if ([".zip", ".tar", ".gz", ".7z", ".bin", ".pt", ".pth", ".safetensors"].includes(extension)) return "binary";
  return "text";
}

export function fileEntryFromPath(filePath: string): FsEntry {
  const name = filePath.split("/").pop() || filePath;
  return {
    name,
    path: filePath,
    type: "file",
    kind: kindFromName(name),
    size: 0,
    modifiedAt: "",
    hidden: name.startsWith("."),
  };
}

export function WorkspaceFiles({
  rootPath,
  changedFiles,
  onOpenFile,
}: {
  rootPath?: string;
  changedFiles?: Array<{ path: string; status?: string }>;
  onOpenFile: (entry: FsEntry) => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const load = async (target?: string) => {
    setLoading(true);
    setError("");
    try {
      setListing(
        await get<FsListing>(
          `/api/fs/list?path=${encodeURIComponent(target ?? rootPath ?? "")}`,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取目录");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(rootPath);
  }, [rootPath]);
  const entries = useMemo(
    () =>
      (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden),
    [listing, showHidden],
  );
  const openChanged = (file: { path: string; status?: string }) => {
    const fullPath = file.path.startsWith("/")
      ? file.path
      : `${rootPath?.replace(/\/$/, "") ?? ""}/${file.path}`;
    const name = fullPath.split("/").pop() ?? fullPath;
    onOpenFile({
      name,
      path: fullPath,
      type: "file",
      kind: kindFromName(name),
      size: 0,
      modifiedAt: "",
      hidden: false,
    });
  };
  return (
    <div className="workspace-files">
      <div className="file-toolbar">
        <button
          className="mini-tool"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
          title="返回上级"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="file-path-button"
          onClick={() => listing && void load(listing.path)}
          title={listing?.path}
        >
          {listing?.path ?? rootPath ?? "工作区"}
        </button>
        <button
          className="mini-tool"
          onClick={() => void load(listing?.path)}
          title="刷新"
        >
          <RefreshCw className={loading ? "spin" : ""} size={14} />
        </button>
      </div>
      {changedFiles?.length ? (
        <div className="changed-files-strip">
          <div className="files-subtitle">本次修改</div>
          {changedFiles.map((file) => (
            <button key={file.path} onClick={() => openChanged(file)}>
              <FileCode2 size={13} />
              <span>{file.path}</span>
              <small>{file.status ?? "M"}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="files-subtitle">
        <span>目录内容</span>
        <label>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          隐藏文件
        </label>
      </div>
      {error && <div className="file-error">{error}</div>}
      <div className="file-entry-list">
        {loading && !listing ? (
          <div className="empty-context">
            <LoaderCircle className="spin" size={15} />
            正在读取目录
          </div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              className="file-entry"
              onClick={() =>
                entry.type === "directory"
                  ? void load(entry.path)
                  : onOpenFile(entry)
              }
            >
              <FileIcon entry={entry} />
              <span>
                <strong>{entry.name}</strong>
                <small>
                  {entry.type === "directory"
                    ? "文件夹"
                    : humanSize(entry.size)}
                </small>
              </span>
              {entry.type === "directory" && <ChevronRight size={13} />}
            </button>
          ))
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="empty-context">此目录为空</div>
        )}
      </div>
      {listing?.truncated && (
        <div className="file-warning">目录项目过多，仅显示前 1000 项</div>
      )}
    </div>
  );
}

export function DirectoryPicker({
  initialPath,
  onSelect,
}: {
  initialPath?: string;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [manualPath, setManualPath] = useState(initialPath ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const load = async (target?: string, selectedPath?: string) => {
    setLoading(true);
    setError("");
    try {
      const value = await get<FsListing>(
        `/api/fs/list?path=${encodeURIComponent(target ?? "")}`,
      );
      setListing(value);
      setManualPath(selectedPath ?? value.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取目录");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(initialPath);
  }, [initialPath]);
  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !listing || creatingFolder) return;
    setCreatingFolder(true);
    setError("");
    try {
      const created = await post<{ name: string; path: string }>("/api/fs/directories", {
        parent: listing.path,
        name,
      });
      setCreating(false);
      setNewFolderName("");
      await load(listing.path, created.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建文件夹");
    } finally {
      setCreatingFolder(false);
    }
  };
  return (
    <div className="directory-picker">
      <div className="directory-path-row">
        <button
          className="icon-button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <ArrowLeft size={17} />
        </button>
        <input
          value={manualPath}
          onChange={(event) => setManualPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(manualPath);
          }}
        />
        <button
          className="secondary-button"
          onClick={() => void load(manualPath)}
        >
          打开
        </button>
        <button
          className="icon-button"
          disabled={!listing || loading}
          onClick={() => setCreating((value) => !value)}
          title="新建文件夹"
          aria-label="新建文件夹"
        >
          <FolderPlus size={17} />
        </button>
      </div>
      {creating && (
        <form className="directory-create-row" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
          <FolderPlus size={16} />
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="文件夹名称"
            maxLength={120}
          />
          <button className="mini-tool" type="submit" disabled={!newFolderName.trim() || creatingFolder} title="创建" aria-label="创建文件夹">
            {creatingFolder ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          </button>
          <button className="mini-tool" type="button" onClick={() => { setCreating(false); setNewFolderName(""); }} title="取消" aria-label="取消创建文件夹">
            <X size={15} />
          </button>
        </form>
      )}
      {error && <div className="file-error">{error}</div>}
      <div className="directory-list">
        {loading && (
          <div className="directory-loading">
            <LoaderCircle className="spin" size={16} />
            正在读取
          </div>
        )}
        {!loading &&
          listing?.entries
            .filter((entry) => entry.type === "directory")
            .map((entry) => (
              <button
                key={entry.path}
                onDoubleClick={() => void load(entry.path)}
                onClick={() => setManualPath(entry.path)}
                className={manualPath === entry.path ? "selected" : ""}
              >
                <Folder size={16} />
                <span>{entry.name}</span>
                <ChevronRight size={14} />
              </button>
            ))}
      </div>
      <div className="directory-picker-foot">
        <span>工作区根目录：{listing?.root ?? "--"}</span>
        <button
          className="primary-button"
          disabled={!manualPath}
          onClick={() => onSelect(manualPath)}
        >
          <Check size={15} />
          选择此文件夹
        </button>
      </div>
    </div>
  );
}

export function FilePreview({
  entry,
  onClose,
}: {
  entry: FsEntry;
  onClose: () => void;
}) {
  const [content, setContent] = useState<TextContent | null>(null);
  const [loading, setLoading] = useState(
    entry.kind === "text" || entry.kind === "markdown",
  );
  const [error, setError] = useState("");
  const lineCount = content?.content.split(/\r?\n/).length;
  const rawUrl = `/api/fs/raw?path=${encodeURIComponent(entry.path)}`;
  useEffect(() => {
    if (entry.kind !== "text" && entry.kind !== "markdown") return;
    setLoading(true);
    get<TextContent>(`/api/fs/content?path=${encodeURIComponent(entry.path)}`)
      .then(setContent)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "无法读取文件"),
      )
      .finally(() => setLoading(false));
  }, [entry]);
  return (
    <div className="preview-overlay" role="dialog" aria-modal="true">
      <section className="preview-window">
        <header className="preview-header">
          <div className="preview-title">
            <FileIcon entry={entry} size={17} />
            <span>
              <strong>{entry.name}</strong>
              <small>{entry.path}{lineCount ? ` · ${lineCount} 行` : ""}</small>
            </span>
          </div>
          <div className="preview-actions">
            <a
              className="icon-button"
              href={rawUrl}
              download={entry.name}
              title="下载"
            >
              <Download size={17} />
            </a>
            <button className="icon-button" onClick={onClose} title="关闭">
              <X size={19} />
            </button>
          </div>
        </header>
        <div className={`preview-body preview-${entry.kind}`}>
          {loading && (
            <div className="preview-loading">
              <LoaderCircle className="spin" size={18} />
              正在读取文件
            </div>
          )}
          {error && <div className="preview-error">{error}</div>}
          {content?.kind === "markdown" && (
            <article className="prose markdown-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                {normalizeMarkdownMath(content.content)}
              </ReactMarkdown>
            </article>
          )}
          {content?.kind === "text" && (
            <LineNumberedText text={content.content} />
          )}
          {entry.kind === "image" && <img src={rawUrl} alt={entry.name} />}
          {entry.kind === "video" && (
            <video src={rawUrl} controls playsInline preload="metadata" />
          )}
          {entry.kind === "audio" && (
            <audio src={rawUrl} controls preload="metadata" />
          )}
          {entry.kind === "pdf" && <iframe src={rawUrl} title={entry.name} />}
          {entry.kind === "binary" && (
            <div className="unsupported-preview">
              <File size={34} />
              <strong>该文件无法在浏览器中预览</strong>
              <span>{humanSize(entry.size)}</span>
              <a className="primary-button" href={rawUrl} download={entry.name}>
                <Download size={15} />
                下载文件
              </a>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
