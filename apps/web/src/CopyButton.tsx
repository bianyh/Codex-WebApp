import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "./WorkspaceFiles";

export function CopyButton({ text, label = "代码内容", className = "" }: { text: string; label?: string; className?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = useCallback(() => {
    void copyText(text).then(() => {
      setCopyState("copied");
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1600);
    }).catch(() => {
      setCopyState("failed");
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2200);
    });
  }, [text]);

  const status = copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制";
  const description = `${status}${label}`;
  return (
    <button
      type="button"
      className={`prose-copy-button ${copyState} ${className}`}
      onClick={copy}
      aria-label={description}
      title={description}
    >
      {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
      <span aria-live="polite" aria-atomic="true">{status}</span>
    </button>
  );
}
