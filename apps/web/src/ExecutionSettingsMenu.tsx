import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { ExecutionControls } from "./RuntimePanels";
import type { ExecutionSettings, ModelOption } from "./types";

export function ExecutionSettingsMenu({ threadId, models, model, value, onChange, disabled }: {
  threadId: string | null; models: ModelOption[]; model: string; value: ExecutionSettings;
  onChange: (value: ExecutionSettings) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0, width: 328, maxHeight: 420 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = models.find((entry) => entry.model === model);
  const summary = [value.mode === "plan" ? "计划" : value.mode === "default" ? "执行" : "", value.effort ?? "", value.serviceTier === "default" ? "标准" : selected?.serviceTiers?.find((tier) => tier.id === value.serviceTier)?.name ?? value.serviceTier ?? ""].filter(Boolean).join(" · ");
  useEffect(() => { setOpen(false); }, [threadId, disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? innerWidth;
      const viewportBottom = topEdge + (viewport?.height ?? innerHeight);
      const width = Math.min(328, viewportWidth - 24);
      const composerTop = trigger.current?.closest(".composer")?.getBoundingClientRect().top ?? rect.top;
      const panelBottom = Math.min(composerTop - 10, viewportBottom - 12);
      setPosition({ width, left: Math.max(leftEdge + 12, Math.min(rect.left, leftEdge + viewportWidth - width - 12)), bottom: innerHeight - panelBottom, maxHeight: Math.max(80, panelBottom - topEdge - 12) });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    const focusOutside = (event: FocusEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    panel.current?.querySelector<HTMLSelectElement>("select")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", focusOutside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); document.removeEventListener("focusin", focusOutside); };
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={trigger} type="button" className={`execution-settings-trigger ${summary ? "configured" : ""} ${open ? "active" : ""}`} disabled={disabled} aria-label="下一轮执行设置" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} title={summary ? `下一轮：${summary}` : "设置推理强度、速度与执行模式"} onClick={() => setOpen((value) => !value)}>
      <SlidersHorizontal size={14} /><span>{summary || "执行设置"}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(<div ref={panel} id={id} className="execution-settings-popover" role="dialog" aria-label="下一轮执行设置" style={position}>
      <header><div><SlidersHorizontal size={16} /><strong>执行设置</strong><small>仅下一轮</small></div><button type="button" className="icon-button" aria-label="关闭执行设置" onClick={close}><X size={16} /></button></header>
      <ExecutionControls models={models} model={model} value={value} disabled={disabled} onChange={onChange} />
      <footer><button type="button" className="execution-settings-reset" disabled={!summary} onClick={() => onChange({})}>恢复默认</button><button type="button" className="execution-settings-done" onClick={close}><Check size={14} />完成</button></footer>
    </div>, document.body)}
  </>;
}
