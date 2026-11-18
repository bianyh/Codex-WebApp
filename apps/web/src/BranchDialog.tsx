import { useEffect, useRef, useState } from "react";
import { GitBranch, LoaderCircle, X } from "lucide-react";
import type { Item } from "./types";
import type { ThreadForkInput } from "../../daemon/src/threadFork";

export function BranchDialog({ item, onCreate, onClose }: {
  item: Item;
  onCreate: (boundary: ThreadForkInput) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"before" | "after">(item.kind === "user" ? "before" : "after");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const initialFocus = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; initialFocus.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending.current) onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const create = async () => {
    if (pending.current || !item.turnId) return;
    pending.current = true; setBusy(true); setError("");
    try {
      await onCreate(mode === "before" ? { beforeTurnId: item.turnId } : { lastTurnId: item.turnId });
      if (mounted.current) onClose();
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "无法创建分支"); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="branch-dialog-title">
    <section className="branch-dialog">
      <header><h3 id="branch-dialog-title"><GitBranch size={18} />从这里创建分支</h3><button ref={initialFocus} className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭分支对话框"><X size={18} /></button></header>
      <p className="muted">选择这轮对话的复制范围，新分支会在创建后自动打开。</p>
      <blockquote className="branch-message-preview">{(item.text ?? "所选消息").slice(0, 600)}{(item.text?.length ?? 0) > 600 ? "…" : ""}</blockquote>
      <fieldset disabled={busy}>
        <legend>分支位置</legend>
        <label className={`branch-choice ${mode === "before" ? "selected" : ""}`}><input type="radio" name="branch-boundary" checked={mode === "before"} onChange={() => setMode("before")} /><span><strong>从这轮之前重新提问</strong><small>复制之前的历史，将本轮第一条用户消息的文字填入输入框，等你编辑后发送。附件需重新添加。</small></span></label>
        <label className={`branch-choice ${mode === "after" ? "selected" : ""}`}><input type="radio" name="branch-boundary" checked={mode === "after"} onChange={() => setMode("after")} /><span><strong>保留这轮并继续</strong><small>复制历史及本轮的完整提问、执行过程和回复，不包含之后的对话。</small></span></label>
      </fieldset>
      <p className="muted branch-note">原对话保留。两个分支共用当前工作目录，文件不会复制或回退。复制的目标会等你发送消息后继续。</p>
      {error && <p className="file-error" role="alert">{error}</p>}
      <footer><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !item.turnId} onClick={() => void create()}>{busy ? <LoaderCircle size={16} className="spin" /> : <GitBranch size={16} />}{busy ? "正在创建…" : "创建并打开分支"}</button></footer>
    </section>
  </div>;
}
