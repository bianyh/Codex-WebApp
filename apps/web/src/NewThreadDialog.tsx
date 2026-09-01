import { useState } from "react";
import { Code2, Folder, X } from "lucide-react";
import { DirectoryPicker } from "./WorkspaceFiles";
import type { ModelOption } from "./types";

export function NewThreadDialog({
  initialPath,
  models,
  defaultModel,
  onClose,
  onCreate,
}: {
  initialPath?: string;
  models: ModelOption[];
  defaultModel?: string;
  onClose: () => void;
  onCreate: (input: {
    cwd: string;
    model?: string;
    sandbox?: string;
    approvalPolicy?: string;
  }) => Promise<void>;
}) {
  const [cwd, setCwd] = useState(initialPath ?? "");
  const [model, setModel] = useState(defaultModel ?? "");
  const [sandbox, setSandbox] = useState("workspace-write");
  const [approvalPolicy, setApprovalPolicy] = useState("on-request");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        cwd,
        model: model || undefined,
        sandbox,
        approvalPolicy,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建线程");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <section className="new-thread-dialog">
        <header>
          <div>
            <span className="eyebrow">NEW THREAD</span>
            <h2>
              <Code2 size={18} />
              在项目中开启会话
            </h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="new-thread-body">
          <label className="field-label">
            <Folder size={14} />
            项目文件夹
          </label>
          <DirectoryPicker initialPath={initialPath} onSelect={setCwd} />
          <div className="selected-directory">
            <span>已选择</span>
            <strong>{cwd || "请选择项目文件夹"}</strong>
          </div>
          <div className="thread-settings-grid">
            <label>
              <span>模型（可选）</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">Codex 默认模型</option>
                {models.map((entry) => (
                  <option key={entry.id} value={entry.model}>{entry.displayName}</option>
                ))}
              </select>
            </label>
            <label>
              <span>沙箱</span>
              <select
                value={sandbox}
                onChange={(event) => setSandbox(event.target.value)}
              >
                <option value="read-only">只读</option>
                <option value="workspace-write">工作区可写</option>
                <option value="danger-full-access">完全访问</option>
              </select>
            </label>
            <label>
              <span>审批策略</span>
              <select
                value={approvalPolicy}
                onChange={(event) => setApprovalPolicy(event.target.value)}
              >
                <option value="on-request">按需审批</option>
                <option value="untrusted">不可信命令审批</option>
                <option value="never">不审批</option>
              </select>
            </label>
          </div>
          {error && <div className="file-error">{error}</div>}
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={!cwd || busy}
            onClick={() => void create()}
          >
            {busy ? "正在创建…" : "创建线程"}
          </button>
        </footer>
      </section>
    </div>
  );
}
