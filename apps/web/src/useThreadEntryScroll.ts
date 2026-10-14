import { useLayoutEffect, useRef, type RefObject } from "react";

type Entry = { threadId: string | null; pending: boolean; stop?: () => void };

/** Anchor once per thread entry, after its bounded history is mounted. Never follow live updates. */
export function useThreadEntryScroll({ selected, renderedThreadId, itemCount, visibleStart, initialCount, setVisibleStart, containerRef, contentRef, reset, positioned }: {
  selected: string | null; renderedThreadId?: string; itemCount: number; visibleStart: number; initialCount: number;
  setVisibleStart: (start: number) => void; containerRef: RefObject<HTMLDivElement | null>; contentRef: RefObject<HTMLDivElement | null>;
  reset: () => void; positioned: () => void;
}) {
  const entryRef = useRef<Entry>({ threadId: null, pending: false });
  const callbacks = useRef({ reset, positioned }); callbacks.current = { reset, positioned };
  useLayoutEffect(() => {
    if (entryRef.current.threadId !== selected) {
      entryRef.current.stop?.();
      entryRef.current = { threadId: selected, pending: Boolean(selected) };
      callbacks.current.reset();
      if (selected !== renderedThreadId) setVisibleStart(0);
    }
    const entry = entryRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!entry.pending || !selected || renderedThreadId !== selected || !container || !content) return;
    const start = Math.max(0, itemCount - initialCount);
    if (visibleStart !== start) { setVisibleStart(start); return; }
    entry.pending = false;
    let stopped = false;
    let frame = 0;
    const anchor = () => {
      if (stopped || entryRef.current !== entry) return;
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
      callbacks.current.positioned();
    };
    const schedule = () => { if (stopped) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(anchor); };
    const observer = new ResizeObserver(schedule);
    const stop = () => {
      if (stopped) return;
      stopped = true; cancelAnimationFrame(frame); clearTimeout(timer); observer.disconnect();
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) container.removeEventListener(type, stop);
    };
    // Briefly account for initial folding, fonts and duplicate HTTP/WS hydration, not ongoing messages.
    const timer = window.setTimeout(stop, 1500);
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) container.addEventListener(type, stop, { passive: true });
    observer.observe(content);
    entry.stop = stop;
    anchor();
    schedule();
    void document.fonts?.ready.then(schedule);
  }, [selected, renderedThreadId, itemCount, visibleStart, initialCount, setVisibleStart, containerRef, contentRef]);
  useLayoutEffect(() => () => entryRef.current.stop?.(), []);
  return () => entryRef.current.stop?.();
}
