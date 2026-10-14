import type { Item } from "./types";
import { fileEntryFromPath, type FsEntry } from "./WorkspaceFiles";
import { resolveLocalFileHref } from "./fileLinks";

export function StructuredItem({ item, cwd, onOpenFile }: { item: Item; cwd?: string; onOpenFile?: (entry: FsEntry) => void }) {
  const path = item.path ? resolveLocalFileHref(item.path, cwd) ?? (item.path.startsWith("/") ? item.path : undefined) : undefined;
  return <details className="timeline-card structured-card" open={item.kind === "image"}>
    <summary><span>{item.title ?? item.kind}</span><span className="card-status">{item.status}</span></summary>
    <div className="card-content">
      {item.text && <p className="structured-text">{item.text}</p>}
      {item.agentThreads?.map((agent) => <div className="agent-thread-card" key={agent.id}><button className="file-link" onClick={() => window.dispatchEvent(new CustomEvent("codex-open-thread", { detail: agent.id }))}>打开子线程：{agent.name ?? agent.id}</button>{agent.status && <small>{agent.status}</small>}{agent.message && <p>{agent.message}</p>}</div>)}
      {item.links?.map((link) => <div className="search-result" key={link.url}><a href={link.url} target="_blank" rel="noreferrer">{link.title}</a>{link.snippet && <p>{link.snippet}</p>}</div>)}
      {item.kind === "image" && (path || item.imageData) && <img className="tool-image" src={path ? `/api/fs/raw?path=${encodeURIComponent(path)}` : item.imageData} alt={item.title ?? "Codex 图片"} loading="lazy" />}
      {path && <button className="file-link" onClick={() => onOpenFile?.(fileEntryFromPath(path))}>预览文件：{item.path}</button>}
      {item.kind === "image" && !path && !item.imageData && <small>Codex 未提供可预览的图片</small>}
    </div>
  </details>;
}
