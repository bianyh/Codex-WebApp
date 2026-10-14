import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import type { ExecutionSettings, ModelOption, QueueEntry, RuntimeInventory, Snapshot } from "./types";

export type Api = <T>(url: string, options?: RequestInit) => Promise<T>;

export function ExecutionControls({ models, model, value, onChange, disabled }: { models: ModelOption[]; model: string; value: ExecutionSettings; onChange: (value: ExecutionSettings) => void; disabled: boolean }) {
  const selected = models.find((entry) => entry.model === model);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const tiers = selected?.serviceTiers ?? [];
  return <div className="execution-controls" role="group" aria-label="下一轮执行设置">
    <label>推理强度<select aria-label="推理强度" value={value.effort ?? ""} disabled={disabled} onChange={(event) => onChange({ ...value, effort: event.target.value || undefined })}>
      <option value="">沿用 Codex 设置</option>
      {(efforts.length ? efforts : selected?.isCustom ? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: "由自定义提供商验证" })) : []).map((entry) => <option value={entry.reasoningEffort} key={entry.reasoningEffort}>{entry.reasoningEffort}</option>)}
    </select></label>
    <label>服务速度<select aria-label="服务速度" value={value.serviceTier ?? ""} disabled={disabled} onChange={(event) => onChange({ ...value, serviceTier: event.target.value || undefined })}>
      <option value="">沿用 Codex 设置</option><option value="default">标准</option>
      {tiers.filter((tier) => tier.id !== "default").map((tier) => <option value={tier.id} key={tier.id}>{tier.name}</option>)}
    </select></label>
    <label>执行模式<select aria-label="执行模式" value={value.mode ?? ""} disabled={disabled || !model} onChange={(event) => onChange({ ...value, mode: event.target.value === "plan" ? "plan" : event.target.value === "default" ? "default" : undefined })}>
      <option value="">沿用 Codex 设置</option><option value="default">执行</option><option value="plan">计划（先讨论方案）</option>
    </select></label>
    <small>作用于下一轮；运行中的引导消息不会切换设置。自定义提供商以实际响应为准。</small>
  </div>;
}

export function QueuePanel({ threadId, queue, api, onUpdate }: { threadId?: string; queue: QueueEntry[]; api: Api; onUpdate: (queue: QueueEntry[]) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedRef = useRef(threadId); selectedRef.current = threadId;
  useEffect(() => { setEditing(null); setError(""); }, [threadId]);
  const mutate = async (body: unknown) => {
    if (!threadId || busy) return;
    setBusy(true); setError(""); const id = threadId;
    try { const result = await api<QueueEntry[]>(`/api/threads/${encodeURIComponent(id)}/queue`, { method: "PATCH", body: JSON.stringify(body) }); if (selectedRef.current === id) { onUpdate(result); setEditing(null); } }
    catch (reason) { if (selectedRef.current === id) setError(reason instanceof Error ? reason.message : "队列操作失败"); }
    finally { setBusy(false); }
  };
  const move = (index: number, direction: -1 | 1) => { const ids = queue.map((entry) => entry.id); const target = index + direction; [ids[index], ids[target]] = [ids[target]!, ids[index]!]; void mutate({ action: "reorder", ids }); };
  return <section className="runtime-panel" aria-label="排队指令">
    <h4>排队指令 · {queue.length}</h4><p className="muted">这是本控制台的内存队列，任务结束后依次发送。不包含其他 CLI 窗口的原生队列，服务重启不会保留。</p>
    {!queue.length && <p className="empty-context">没有待发送指令</p>}
    {queue.map((entry, index) => <article className="queue-entry" key={entry.id}>
      <div className="usage-row"><strong>#{index + 1}</strong><small>{entry.model ?? "沿用模型"}{entry.mode ? ` · ${entry.mode}` : ""}{entry.effort ? ` · ${entry.effort}` : ""}{entry.serviceTier ? ` · ${entry.serviceTier}` : ""}</small></div>
      {editing === entry.id ? <><textarea aria-label="编辑排队指令" value={text} onChange={(event) => setText(event.target.value)} /><button disabled={busy || (!text.trim() && !entry.attachments?.length)} onClick={() => void mutate({ action: "edit", id: entry.id, text })}>保存指令</button><button disabled={busy} onClick={() => setEditing(null)}>取消编辑</button></> : <p className="queue-text">{entry.text || "仅附件"}</p>}
      {entry.attachments?.map((file, i) => <small className="queue-attachment" key={`${file.name}-${i}`}>{file.name} · {file.kind}</small>)}
      <div className="queue-actions">
        <button disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`上移指令 ${index + 1}`}><ArrowUp size={15} /></button>
        <button disabled={busy || index === queue.length - 1} onClick={() => move(index, 1)} aria-label={`下移指令 ${index + 1}`}><ArrowDown size={15} /></button>
        <button disabled={busy} onClick={() => { setEditing(entry.id); setText(entry.text); }} aria-label={`编辑指令 ${index + 1}`}><PencilLine size={15} /></button>
        <button disabled={busy} onClick={() => void mutate({ action: "delete", id: entry.id })} aria-label={`取消指令 ${index + 1}`}><Trash2 size={15} /></button>
      </div>
    </article>)}
    {error && <p role="alert" className="file-error">{error}</p>}
  </section>;
}

export function UsagePanel({ snapshot, queueLength, api }: { snapshot: Snapshot | null; queueLength: number; api: Api }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  useEffect(() => { setError(""); setRequested(false); }, [snapshot?.thread.id]);
  const usage = snapshot?.tokenUsage;
  const last = usage?.last;
  const pressure = usage?.modelContextWindow && last?.total !== undefined ? last.total / usage.modelContextWindow : undefined;
  const active = snapshot && ["running", "waiting_approval", "waiting_input"].includes(snapshot.thread.status);
  const compact = async () => {
    if (!snapshot || !window.confirm("压缩会整理模型上下文，不撤销文件修改。确定执行？")) return;
    setBusy(true); setError("");
    try { await api(`/api/threads/${encodeURIComponent(snapshot.thread.id)}/compact`, { method: "POST", body: "{}" }); setRequested(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "压缩失败"); }
    finally { setBusy(false); }
  };
  return <section className="runtime-panel" aria-label="上下文用量">
    <h4>上下文压力</h4>
    <div className="usage-total">{pressure === undefined ? "--" : `${Math.round(pressure * 100)}%`}</div>
    {pressure !== undefined && <progress max={100} value={Math.min(100, pressure * 100)} aria-label="上下文占用" />}
    <p className="muted">最近一轮总 Token / 模型上下文容量（估算，不是账户配额）</p>
    <div className="usage-row"><span>最近一轮</span><strong>{last?.total?.toLocaleString() ?? "--"}</strong></div>
    <div className="usage-row"><span>模型容量</span><strong>{usage?.modelContextWindow?.toLocaleString() ?? "--"}</strong></div>
    <h4>线程累计用量</h4>
    {([ ["总量", usage?.total], ["输入", usage?.input], ["输出", usage?.output], ["缓存输入", usage?.cachedInput], ["推理输出", usage?.reasoningOutput] ] as const).map(([label, value]) => <div className="usage-row" key={label}><span>{label}</span><strong>{value?.toLocaleString() ?? "--"}</strong></div>)}
    <button className="secondary-button" disabled={!snapshot || Boolean(active) || Boolean(queueLength) || snapshot.thread.canRetry !== true || busy || snapshot.compaction === "running" || (requested && !snapshot.compaction)} onClick={() => void compact()}>压缩上下文</button>
    <p className="muted">{snapshot?.compaction === "running" || (requested && !snapshot?.compaction) ? "正在压缩…" : snapshot?.compaction === "completed" ? "上下文压缩完成" : snapshot?.compaction === "failed" ? "上下文压缩失败，可重试" : "仅空闲、由控制台持有且无排队指令的线程可操作。"}</p>
    {error && <p role="alert" className="file-error">{error}</p>}
    <h4>当前运行设置</h4>
    {([ ["模型", snapshot?.thread.runtimeSettings?.model ?? snapshot?.thread.model], ["提供商", snapshot?.thread.runtimeSettings?.modelProvider], ["推理", snapshot?.thread.runtimeSettings?.effort], ["速度", snapshot?.thread.runtimeSettings?.serviceTier], ["模式", snapshot?.thread.runtimeSettings?.mode], ["审批", snapshot?.thread.runtimeSettings?.approvalPolicy], ["沙箱", snapshot?.thread.runtimeSettings?.sandbox] ] as const).map(([label, value]) => <div className="usage-row" key={label}><span>{label}</span><strong>{value ?? "未提供"}</strong></div>)}
    {snapshot?.thread.runtimeSettings?.reroutedFrom && <p className="muted">模型已从 {snapshot.thread.runtimeSettings.reroutedFrom} 路由到 {snapshot.thread.runtimeSettings.model}：{snapshot.thread.runtimeSettings.rerouteReason}</p>}
  </section>;
}

export function RuntimeStatusPanel({ threadId, api }: { threadId?: string; api: Api }) {
  const [data, setData] = useState<RuntimeInventory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const read = async () => { setBusy(true); try { const result = await api<RuntimeInventory>(`/api/runtime/status${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`); if (!cancelled) { setData(result); setError(""); } } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取状态"); } finally { if (!cancelled) setBusy(false); } };
    setData(null); void read(); const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [threadId, api, refresh]);
  return <section className="runtime-panel" aria-label="Codex 能力状态">
    <div className="usage-row"><h4>账户与能力状态</h4><button className="icon-button" disabled={busy} aria-label="刷新能力状态" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} className={busy ? "spin" : ""} /></button></div>
    <p className="muted">只读本机 Codex 状态；不执行安装、登录或配置修改。不显示凭据和原始配置。</p>
    {busy && !data && <p>正在读取…</p>}{error && <p role="alert" className="file-error">{error}</p>}
    {data && <>
      <h4>账户配额</h4>{data.quotas.error && <p className="muted">{data.quotas.error}</p>}
      {data.quotas.ordinaryUsageAllowed === false && <p className="file-error">账户当前不允许普通额度使用；以 Codex 后端状态为准。</p>}
      {!data.quotas.entries.length && <p className="muted">没有可用配额数据（第三方 API 可能不提供）</p>}
      {data.quotas.entries.map((quota) => <article className="inventory-entry" key={quota.id}><strong>{quota.name} {quota.planType ?? ""}</strong>{quota.reached && <p>{quota.reached}</p>}
        {[quota.primary, quota.secondary].map((window, index) => window && <div key={index}><div className="usage-row"><span>{window.windowDurationMins ? `${window.windowDurationMins} 分钟窗口` : index ? "次额度" : "主额度"}</span><strong>已用 {window.usedPercent}%</strong></div><progress max={100} value={Math.min(100, window.usedPercent)} />{window.resetsAt && <small>重置时间：{new Date(window.resetsAt * 1000).toLocaleString()}</small>}</div>)}
      </article>)}
      {([ ["mcp", "MCP 服务器"], ["skills", "Skills"], ["plugins", "已安装插件"], ["hooks", "Hooks"] ] as const).map(([key, label]) => <section key={key}><h4>{label}</h4>{data[key].error && <p className="muted">{data[key].error}</p>}{!data[key].entries.length && <p className="muted">{data[key].available ? "当前没有条目" : "不可用"}</p>}{data[key].entries.map((entry, index) => <article key={`${entry.id}-${index}`} className="inventory-entry"><div className="usage-row"><strong>{entry.name}</strong><span>{entry.status}</span></div>{entry.description && <p>{entry.description}</p>}{entry.toolCount !== undefined && <small>{entry.toolCount} 个工具</small>}{entry.path && <small className="inventory-path">{entry.path}</small>}</article>)}</section>)}
    </>}
  </section>;
}
