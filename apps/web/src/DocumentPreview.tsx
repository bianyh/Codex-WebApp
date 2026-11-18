import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { AnnotationMode, getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const binaryRoot = "../../../node_modules/pdfjs-dist/";
const resources = import.meta.glob<string>([
  "../../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm}",
  "!../../../node_modules/pdfjs-dist/wasm/quickjs-eval.wasm",
], {
  import: "default", eager: true, query: "?url&no-inline",
});
const resourceDirectories: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };

class PdfResources {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = resources[`${binaryRoot}${resourceDirectories[kind]}/${filename}`];
    if (!url) throw new Error("Missing bundled PDF resource");
    const response = await fetch(url);
    if (!response.ok) throw new Error("Unable to load bundled PDF resource");
    return new Uint8Array(await response.arrayBuffer());
  }
}

export default function DocumentPreview({ url, word, initialPage }: { url: string; word: boolean; initialPage: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(initialPage);
  const [width, setWidth] = useState(0);
  const [loadingError, setLoadingError] = useState("");
  const [renderedPage, setRenderedPage] = useState<number>();
  const [renderError, setRenderError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | undefined;
    void (async () => {
      let source: { data: ArrayBuffer } | { url: string } = { url };
      if (word) {
        const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error?.message || "Word 文档无法预览，请下载原文件查看。");
        }
        source = { data: await response.arrayBuffer() };
      }
      if (controller.signal.aborted) return;
      loadingTask = getDocument({ ...source, BinaryDataFactory: PdfResources, useWorkerFetch: false, enableXfa: false });
      const loaded = await loadingTask.promise;
      if (controller.signal.aborted) return;
      setPage(Math.min(initialPage, loaded.numPages));
      setPdf(loaded);
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof Error && reason.name === "PasswordException") setLoadingError("此 PDF 需要密码，请下载后打开。");
      else setLoadingError(word && !loadingTask && reason instanceof Error ? reason.message : "无法打开 PDF，请确认文件存在且可读取，或下载后查看。");
    });
    return () => {
      controller.abort();
      void loadingTask?.destroy().catch(() => {});
    };
  }, [url, word, initialPage]);

  useEffect(() => {
    const element = sheet.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const surface = canvas.current;
    if (!pdf || !surface || width <= 0) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    setRenderError("");
    void (async () => {
      const selected = await pdf.getPage(page);
      if (cancelled) return;
      const original = selected.getViewport({ scale: 1 });
      const scale = Math.min(width, 1000) / original.width;
      const viewport = selected.getViewport({ scale });
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (viewport.width * viewport.height)), 4096 / Math.max(viewport.width, viewport.height));
      surface.width = Math.max(1, Math.floor(viewport.width * density));
      surface.height = Math.max(1, Math.floor(viewport.height * density));
      surface.style.width = `${viewport.width}px`;
      renderTask = selected.render({ canvas: surface, viewport, transform: [density, 0, 0, density, 0, 0], annotationMode: AnnotationMode.DISABLE });
      await renderTask.promise;
      if (!cancelled) setRenderedPage(page);
    })().catch(() => { if (!cancelled) setRenderError("此页无法显示，请下载文件查看。"); });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, page, width]);

  const changePage = (next: number) => {
    setRenderedPage(undefined);
    setRenderError("");
    setPage(next);
    scroller.current?.scrollTo({ top: 0 });
  };

  return <div className="document-preview">
    {pdf && <div className="document-preview-toolbar">
      <button type="button" className="icon-button" aria-label="上一页" onClick={() => changePage(page - 1)} disabled={page <= 1}><ChevronLeft size={19} /></button>
      <span aria-live="polite">第 {page} / {pdf.numPages} 页</span>
      <button type="button" className="icon-button" aria-label="下一页" onClick={() => changePage(page + 1)} disabled={page >= pdf.numPages}><ChevronRight size={19} /></button>
    </div>}
    <div className="document-preview-scroll" ref={scroller}>
      <div className="document-preview-sheet" ref={sheet}>
        {(loadingError || renderError) && <div className="preview-error" role="alert">{loadingError || renderError}</div>}
        {!loadingError && !renderError && renderedPage !== page && <div className="preview-loading" role="status"><LoaderCircle size={18} className="spin" />{!pdf && word ? "正在转换 Word 文档" : "正在读取文档"}</div>}
        <canvas ref={canvas} role="img" aria-label={`文档第 ${page} 页`} hidden={renderedPage !== page || Boolean(renderError)} />
      </div>
    </div>
  </div>;
}
