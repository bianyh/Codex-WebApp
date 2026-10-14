import { useEffect, useState } from "react";
import { Pause, PencilLine, Play, RefreshCw, Target, Trash2 } from "lucide-react";
import { goalStatusLabels, parseGoalBudget } from "./goalState";
import type { GoalState, GoalUpdate } from "./types";

export type GoalControls = { state: GoalState | null; busy: boolean; loading: boolean; error: string; reload: () => Promise<void>; mutate: (update: GoalUpdate | null) => Promise<void> };

export function GoalPanel({ threadId, controls }: { threadId?: string; controls: GoalControls }) {
  const { state, busy, loading, error, reload, mutate } = controls;
  const goal = state?.goal;
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [activateOnCreate, setActivateOnCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [validation, setValidation] = useState("");
  useEffect(() => { setEditing(false); setConfirmDelete(false); setValidation(""); }, [threadId]);
  const beginEdit = (activate = false) => {
    setObjective(goal?.objective ?? ""); setBudget(goal?.tokenBudget?.toString() ?? "");
    setActivateOnCreate(activate); setEditing(true); setValidation("");
  };
  const run = async (update: GoalUpdate | null) => {
    try { await mutate(update); setConfirmDelete(false); return true; } catch { return false; }
  };
  const save = async () => {
    if (!objective.trim()) { setValidation("目标内容不能为空"); return; }
    let tokenBudget: number | null;
    try { tokenBudget = parseGoalBudget(budget); } catch (reason) { setValidation(reason instanceof Error ? reason.message : "预算无效"); return; }
    if (await run({ objective: objective.trim(), tokenBudget, ...(!goal ? { status: activateOnCreate ? "active" as const : "paused" as const } : {}) })) setEditing(false);
  };
  const disabled = busy || loading || state?.canControl !== true || state?.supported !== true;
  if (!threadId) return <div className="empty-context">请选择一个线程</div>;
  return (
    <section className="goal-panel" aria-label="目标控制">
      <header className="goal-panel-header"><h3><Target size={16} />Goal · 目标</h3><button className="icon-button" onClick={() => void reload()} disabled={busy || loading} aria-label="刷新目标"><RefreshCw size={15} /></button></header>
      <div className="goal-mode-row">
        <span>目标模式 {goal ? <small className={`goal-status ${goal.status}`}>{goalStatusLabels[goal.status]}</small> : <small>未设置</small>}</span>
        <button className="goal-switch" role="switch" aria-label="目标模式开关" aria-checked={goal?.status === "active"} disabled={disabled} onClick={() => goal ? void run({ status: goal.status === "active" ? "paused" : "active" }) : beginEdit(true)}>{goal?.status === "active" ? "开启" : "关闭"}</button>
      </div>
      {loading && <p className="goal-note">正在读取目标…</p>}
      {error && <p className="goal-error" role="alert">{error}</p>}
      {state?.controlReason && <p className="goal-note">{state.controlReason}</p>}
      {goal && <>
        <div className="goal-objective">{goal.objective}</div>
        <dl className="goal-metrics"><div><dt>已用 Token</dt><dd>{goal.tokensUsed.toLocaleString()}</dd></div><div><dt>预算</dt><dd>{goal.tokenBudget?.toLocaleString() ?? "不限"}</dd></div><div><dt>目标耗时</dt><dd>{Math.floor(goal.timeUsedSeconds / 60)} 分 {Math.floor(goal.timeUsedSeconds % 60)} 秒</dd></div></dl>
        {goal.tokenBudget !== null && <progress className="goal-progress" aria-label="目标预算消耗" max={goal.tokenBudget} value={Math.min(goal.tokensUsed, goal.tokenBudget)} />}
        <div className="goal-actions">
          <button className="secondary-button" disabled={disabled} onClick={() => void run({ status: goal.status === "active" ? "paused" : "active" })}>{goal.status === "active" ? <Pause size={14} /> : <Play size={14} />}{goal.status === "active" ? "暂停目标" : "继续目标"}</button>
          <button className="secondary-button" disabled={disabled} onClick={() => beginEdit()}><PencilLine size={14} />编辑目标</button>
          <button className="secondary-button goal-danger" disabled={disabled} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除目标</button>
        </div>
      </>}
      {!goal && !editing && <button className="primary-button" disabled={disabled} onClick={() => beginEdit()}>设置目标</button>}
      {editing && <form className="goal-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>目标内容<textarea aria-label="目标内容" rows={6} value={objective} maxLength={32000} onChange={(event) => setObjective(event.target.value)} /></label>
        <label>Token 预算（可选）<input aria-label="目标 Token 预算" type="text" inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="留空表示不限预算" /></label>
        {!goal && <label className="goal-checkbox"><input type="checkbox" checked={activateOnCreate} onChange={(event) => setActivateOnCreate(event.target.checked)} />保存后立即启用目标</label>}
        {validation && <p className="goal-error" role="alert">{validation}</p>}
        <div className="goal-actions"><button className="primary-button" disabled={disabled} type="submit">{!goal && activateOnCreate ? "创建并启用" : "保存目标"}</button><button className="secondary-button" type="button" onClick={() => setEditing(false)}>取消编辑</button></div>
      </form>}
      {confirmDelete && <div className="goal-delete-confirm" role="alert"><p>删除目标及其预算设置？不会删除对话或项目文件。</p><div className="goal-actions"><button className="secondary-button goal-danger" disabled={disabled} onClick={() => void run(null)}>确认删除目标</button><button className="secondary-button" onClick={() => setConfirmDelete(false)}>保留目标</button></div></div>}
      <p className="goal-note">关闭开关等同于暂停，保留目标。暂停/删除停止目标自动续跑；当前消息是否停止由 Codex 决定，如需立即打断，请使用对话框的停止按钮。启用或继续目标可能立即开始自动执行。</p>
    </section>
  );
}
