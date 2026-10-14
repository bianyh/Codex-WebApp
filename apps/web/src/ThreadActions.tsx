import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Thread } from "./types";

export function ThreadActions({ thread, archived, onAction, onClose }: { thread: Thread; archived: boolean; onAction: (action: "name" | "fork" | "archive" | "unarchive", name?: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = ["running", "waiting_approval", "waiting_input"].includes(thread.status);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, [busy, onClose]);
  const run = async (action: "name" | "fork" | "archive" | "unarchive") => { if (busy) return; if (action === "archive" && !window.confirm("归档此线程？不会删除聊天记录或文件。")) return; setBusy(true); setError(""); try { await onAction(action, name.trim()); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "线程操作失败"); } finally { setBusy(false); } };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="线程操作"><section className="thread-actions-dialog"><header><h3>线程操作</h3><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭线程操作"><X size={18} /></button></header>
    <label>线程名称<input aria-label="线程名称" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} /></label>
    <button disabled={busy || !name.trim()} onClick={() => void run("name")}>保存名称</button>
    <button disabled={busy || active || archived} onClick={() => void run("fork")}>创建对话分支</button><p className="muted">复制截至当前的历史到新线程；原线程和文件不回退。</p>
    <button disabled={busy || (active && !archived)} onClick={() => void run(archived ? "unarchive" : "archive")}>{archived ? "恢复归档线程" : "归档此线程"}</button>
    {active && <p className="muted">请先结束活动任务，再分支或归档。</p>}{error && <p role="alert" className="file-error">{error}</p>}
  </section></div>;
}
