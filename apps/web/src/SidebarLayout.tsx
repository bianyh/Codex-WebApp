import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

type Side = "left" | "right";

const minimumWidth = { left: 220, right: 260 };
const maximumWidth = 560;
const conversationWidth = 420;
const widthKey = (side: Side) => `codex-console-${side}-sidebar-width`;

function readWidth(side: Side): number | undefined {
  const width = Number(localStorage.getItem(widthKey(side)));
  return Number.isFinite(width) && width >= minimumWidth[side] && width <= maximumWidth ? width : undefined;
}

function clampWidth(width: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(width)));
}

function SidebarSeparator({ side, width, max, visible, onResize }: {
  side: Side;
  width: number;
  max: number;
  visible: boolean;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ id: number; startX: number; startWidth: number; width: number; resized: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const min = minimumWidth[side];
  const direction = side === "left" ? 1 : -1;
  const label = side === "left" ? "调整线程侧栏宽度" : "调整上下文侧栏宽度";

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (current.resized) localStorage.setItem(widthKey(side), String(current.width));
  };

  return (
    <div
      className={`sidebar-separator sidebar-separator-${side}${dragging ? " dragging" : ""}`}
      hidden={!visible}
      role="separator"
      tabIndex={0}
      title={label}
      aria-label={label}
      aria-controls={side === "left" ? "thread-sidebar" : "context-sidebar"}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width, width, resized: false };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const next = clampWidth(current.startWidth + (event.clientX - current.startX) * direction, min, max);
        if (next === current.width) return;
        current.width = next;
        current.resized = true;
        onResize(next);
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onKeyDown={(event) => {
        const keys: Record<string, number> = { ArrowLeft: width - 16 * direction, ArrowRight: width + 16 * direction, Home: min, End: max };
        if (!Object.hasOwn(keys, event.key)) return;
        event.preventDefault();
        const next = clampWidth(keys[event.key]!, min, max);
        if (next === width) return;
        onResize(next);
        localStorage.setItem(widthKey(side), String(next));
      }}
    />
  );
}

export function SidebarLayout({ leftCollapsed, rightCollapsed, children }: {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  children: ReactNode;
}) {
  const [preferred, setPreferred] = useState(() => ({ left: readWidth("left"), right: readWidth("right") }));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const desktop = viewportWidth >= 1121;
  const leftVisible = !leftCollapsed && viewportWidth > 720;
  const rightVisible = !rightCollapsed && desktop;
  const available = viewportWidth - conversationWidth;
  // With both sidebars open, give them equal room to expand and reserve space for the conversation.
  const sidebarBudget = leftVisible && rightVisible ? Math.floor(available / 2) : available;
  const maxLeft = clampWidth(sidebarBudget, minimumWidth.left, maximumWidth);
  const maxRight = clampWidth(sidebarBudget, minimumWidth.right, maximumWidth);
  const leftWidth = clampWidth(preferred.left ?? (desktop ? 292 : 270), minimumWidth.left, maxLeft);
  const rightWidth = clampWidth(preferred.right ?? 350, minimumWidth.right, maxRight);
  const style = { "--left-sidebar-width": `${leftWidth}px`, "--right-sidebar-width": `${rightWidth}px` } as CSSProperties;

  return (
    <div className={`app-shell ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`} style={style}>
      {children}
      <SidebarSeparator side="left" width={leftWidth} max={maxLeft} visible={leftVisible} onResize={(left) => setPreferred((widths) => ({ ...widths, left }))} />
      <SidebarSeparator side="right" width={rightWidth} max={maxRight} visible={rightVisible} onResize={(right) => setPreferred((widths) => ({ ...widths, right }))} />
    </div>
  );
}
