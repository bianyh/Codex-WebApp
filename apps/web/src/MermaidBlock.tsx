import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { Code2, LoaderCircle } from "lucide-react";
import type { ThemeMode } from "./types";

export const MermaidTheme = createContext<ThemeMode>("dark");

type DiagramImage = { url: string; width?: number; height?: number };
type DiagramResult = { source: string; theme: ThemeMode; image: DiagramImage | null };

let renderQueue = Promise.resolve();
let renderId = 0;

function renderDiagram(source: string, theme: ThemeMode, signal: AbortSignal) {
  // Mermaid's configuration is shared by all diagrams in this page.
  const render = renderQueue.then(async (): Promise<DiagramImage | null> => {
    if (signal.aborted) return null;
    if (source.length > 50_000) throw new Error("Mermaid source is too large");

    // Preserve the original source for display and copy. The render input uses
    // the app's security and theme settings, with no remote image nodes.
    const diagram = source.replace(/\r\n?/g, "\n")
      .replace(/%%\{[\s\S]*?(?:\}%%|$)/g, "")
      .trim()
      .replace(/^---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(?:\n|$)/, "")
      .trim();
    if (!diagram || diagram.startsWith("---") || /@\{[^}]*\b(?:img|image)\b/i.test(diagram)) {
      throw new Error("Unsupported Mermaid source");
    }

    const { default: mermaid } = await import("mermaid");
    if (signal.aborted) return null;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      logLevel: "fatal",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: 'Arial, "Noto Sans CJK SC", sans-serif',
    });

    const container = document.createElement("div");
    container.className = "mermaid-render-container";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`codex-mermaid-${++renderId}`, diagram, container);
      const documentSvg = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      if (documentSvg.localName !== "svg") throw new Error("Invalid Mermaid SVG");
      const [, , viewWidth = 0, viewHeight = 0] = documentSvg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
      return {
        url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        width: Number.isFinite(viewWidth) && viewWidth > 0 ? Math.ceil(viewWidth) : undefined,
        height: Number.isFinite(viewHeight) && viewHeight > 0 ? Math.ceil(viewHeight) : undefined,
      };
    } finally {
      container.remove();
    }
  });
  renderQueue = render.then(() => {}, () => {});
  return render;
}

export function MermaidBlock({ source, copyButton }: { source: string; copyButton: ReactNode }) {
  const theme = useContext(MermaidTheme);
  const sourceId = useId();
  const [sourceVisible, setSourceVisible] = useState<boolean>();
  const [result, setResult] = useState<DiagramResult>();
  const currentResult = result?.source === source && result.theme === theme ? result : undefined;
  const image = currentResult?.image;
  const failed = image === null;
  const showSource = sourceVisible ?? failed;

  useEffect(() => {
    const controller = new AbortController();
    const finish = (image: DiagramImage | null) => {
      if (!controller.signal.aborted) setResult({ source, theme, image });
    };
    // Give streamed code a chance to complete before starting another layout.
    const timer = window.setTimeout(() => {
      void renderDiagram(source, theme, controller.signal).then(finish, () => finish(null));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [source, theme]);

  return (
    <div className="prose-code-block mermaid-block">
      <div className="prose-code-toolbar">
        <span>Mermaid</span>
        <div className="mermaid-actions">
          <button
            type="button"
            className="prose-copy-button"
            aria-controls={sourceId}
            aria-expanded={showSource}
            onClick={() => setSourceVisible(!showSource)}
          >
            <Code2 size={14} aria-hidden="true" />
            {showSource ? "收起源码" : "查看源码"}
          </button>
          {copyButton}
        </div>
      </div>
      {image ? (
        <div className="mermaid-preview" role="region" aria-label="Mermaid 图表预览" tabIndex={0}>
          <img
            src={image.url}
            width={image.width}
            height={image.height}
            alt="Mermaid 图表"
            onError={() => setResult({ source, theme, image: null })}
          />
        </div>
      ) : (
        <div className="mermaid-status" role="status">
          {!failed && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
          {failed ? "无法渲染此 Mermaid 图表" : "正在渲染图表"}
        </div>
      )}
      <pre id={sourceId} hidden={!showSource}><code>{source}</code></pre>
    </div>
  );
}
