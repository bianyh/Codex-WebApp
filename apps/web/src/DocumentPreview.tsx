import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus } from "lucide-react";
import { AnnotationMode, getDocument, GlobalWorkerOptions, PDFWorker, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { pdfLayout, pdfPageAt, pdfTiles, type PdfPageBox, type PdfTileBox, type PdfViewport } from "./pdfLayout";

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

export default function DocumentPreview({ url, office, officeData, initialPage }: { url: string; office?: "word" | "presentation"; officeData?: Promise<ArrayBuffer>; initialPage: number }) {
  const [document, setDocument] = useState<{ pdf: PDFDocumentProxy; page: number; ratio: number }>();
  const [loadingError, setLoadingError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const worker = officeData ? new PDFWorker() : undefined;
    void worker?.promise.catch(() => {});
    let loadingTask: PDFDocumentLoadingTask | undefined;
    void (async () => {
      const source = officeData ? { data: await officeData } : { url };
      if (controller.signal.aborted) return;
      loadingTask = getDocument({ ...source, worker, BinaryDataFactory: PdfResources, useWorkerFetch: false, enableXfa: false });
      const pdf = await loadingTask.promise;
      const page = Math.min(initialPage, pdf.numPages);
      const { width, height } = (await pdf.getPage(page)).getViewport({ scale: 1 });
      if (controller.signal.aborted) return;
      setDocument({ pdf, page, ratio: height / width });
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof Error && reason.name === "PasswordException") setLoadingError("此 PDF 需要密码，请下载后打开。");
      else setLoadingError(office && !loadingTask && reason instanceof Error ? reason.message : "无法打开预览，请确认文件存在且可读取，或下载后查看。");
    });
    return () => {
      controller.abort();
      if (loadingTask) void loadingTask.destroy().catch(() => {}).finally(() => worker?.destroy());
      else worker?.destroy();
    };
  }, [url, office, officeData, initialPage]);

  if (document) return <PdfReader pdf={document.pdf} initialPage={document.page} fallbackRatio={document.ratio} />;
  return <div className="document-preview-pending">
    {loadingError ? <div className="preview-error" role="alert">{loadingError}</div> : <div className="preview-loading" role="status"><LoaderCircle size={18} className="spin" />{office === "presentation" ? "正在转换幻灯片" : office === "word" ? "正在转换 Word 文档" : "正在读取文档"}</div>}
  </div>;
}

const zoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const descendingZoomSteps = [...zoomSteps].reverse();
const minZoom = zoomSteps[0]!;
const maxZoom = zoomSteps.at(-1)!;
const noView: PdfViewport = { top: 0, left: 0, width: 0, height: 0 };
type PdfLayout = ReturnType<typeof pdfLayout>;
type ZoomPoint = { x: number; y: number };
type ReadingAnchor = { page: number; y: number; x: number; point?: ZoomPoint };

function readingAnchor(layout: PdfLayout, view: PdfViewport, point?: ZoomPoint): ReadingAnchor {
  const x = view.left + (point?.x ?? view.width / 2);
  const y = view.top + (point?.y ?? 0);
  const page = pdfPageAt(layout.pages, y + (point ? 0 : 12));
  const box = layout.pages[page]!;
  return { page, y: (y - box.top) / box.height, x: (x - layout.pageLeft) / layout.pageWidth, point };
}

function viewFrom(element: HTMLDivElement): PdfViewport {
  return { top: element.scrollTop, left: element.scrollLeft, width: element.clientWidth, height: element.clientHeight };
}

function PdfReader({ pdf, initialPage, fallbackRatio }: { pdf: PDFDocumentProxy; initialPage: number; fallbackRatio: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const pendingAnchor = useRef<ReadingAnchor | null>({ page: initialPage - 1, y: 0, x: 0.5 });
  const [view, setView] = useState(noView);
  const [zoom, setZoom] = useState(1);
  const requestedZoom = useRef(1);
  const [ratios, setRatios] = useState<ReadonlyMap<number, number>>(() => new Map([[initialPage - 1, fallbackRatio]]));
  const layout = useMemo(() => pdfLayout(pdf.numPages, ratios, fallbackRatio, { ...noView, width: view.width, height: view.height }, zoom), [pdf.numPages, ratios, fallbackRatio, view.width, view.height, zoom]);
  const drawnLayout = useRef(layout);
  const drawnSize = useRef({ width: 0, height: 0 });

  const readScroll = useCallback(() => {
    if (!scroller.current) return;
    const next = viewFrom(scroller.current);
    setView((old) => old.top === next.top && old.left === next.left && old.width === next.width && old.height === next.height ? old : next);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current!;
    readScroll();
    const observer = new ResizeObserver(() => {
      const previous = drawnSize.current;
      if (previous.width && (previous.width !== element.clientWidth || previous.height !== element.clientHeight)) {
        pendingAnchor.current ??= readingAnchor(drawnLayout.current, { ...viewFrom(element), ...previous });
      }
      readScroll();
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(scrollFrame.current); };
  }, [readScroll]);

  useLayoutEffect(() => {
    if (!view.width || !scroller.current) return;
    drawnLayout.current = layout;
    drawnSize.current = { width: view.width, height: view.height };
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!anchor) return;
    const box = layout.pages[anchor.page]!;
    scroller.current.scrollTo({
      top: box.top + anchor.y * box.height - (anchor.point?.y ?? 0),
      left: layout.pageLeft + anchor.x * layout.pageWidth - (anchor.point?.x ?? view.width / 2),
    });
    readScroll();
  }, [layout, readScroll, view.width, view.height]);

  const storeRatio = useCallback((index: number, ratio: number) => {
    if (scroller.current && ratios.get(index) !== ratio) {
      pendingAnchor.current ??= readingAnchor(drawnLayout.current, viewFrom(scroller.current));
      setRatios((old) => new Map(old).set(index, ratio));
    }
  }, [ratios]);

  const changeZoom = useCallback((next: number, point?: ZoomPoint) => {
    const zoom = Math.min(maxZoom, Math.max(minZoom, next));
    if (zoom === requestedZoom.current || !scroller.current || drawnSize.current.width === 0) return;
    pendingAnchor.current = readingAnchor(drawnLayout.current, viewFrom(scroller.current), point);
    requestedZoom.current = zoom;
    setZoom(zoom);
  }, []);

  useEffect(() => {
    const element = scroller.current!;
    let frame = 0;
    let delta = 0;
    let point: ZoomPoint | undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        changeZoom(requestedZoom.current * Math.exp(-delta * 0.0025), point);
        frame = 0;
        delta = 0;
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => { element.removeEventListener("wheel", onWheel); cancelAnimationFrame(frame); };
  }, [changeZoom]);

  const zoomIn = () => changeZoom(zoomSteps.find((step) => step > zoom + 0.00001) ?? maxZoom);
  const zoomOut = () => changeZoom(descendingZoomSteps.find((step) => step < zoom - 0.00001) ?? minZoom);

  const jump = (index: number) => {
    scroller.current?.scrollTo({ top: layout.pages[index]?.top ?? 0 });
    readScroll();
  };

  const active = view.width ? pdfPageAt(layout.pages, view.top + 12) : initialPage - 1;
  const first = pdfPageAt(layout.pages, Math.max(0, view.top - 160));
  const last = pdfPageAt(layout.pages, view.top + view.height + 160);
  const density = Math.min(3, window.devicePixelRatio || 1);

  return <div className="document-preview">
    <div className="document-preview-toolbar">
      <div className="document-preview-controls">
        <button type="button" className="icon-button" aria-label="上一页" onClick={() => jump(active - 1)} disabled={active === 0}><ChevronLeft size={19} /></button>
        <span aria-live="polite">第 {active + 1} / {pdf.numPages} 页</span>
        <button type="button" className="icon-button" aria-label="下一页" onClick={() => jump(active + 1)} disabled={active + 1 >= pdf.numPages}><ChevronRight size={19} /></button>
      </div>
      <div className="document-preview-controls">
        <button type="button" className="icon-button" aria-label="缩小" onClick={zoomOut} disabled={zoom <= minZoom}><Minus size={17} /></button>
        <button type="button" className="document-preview-fit" aria-label="适应宽度" title="适应宽度" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" className="icon-button" aria-label="放大" onClick={zoomIn} disabled={zoom >= maxZoom}><Plus size={17} /></button>
      </div>
    </div>
    <div className="document-preview-scroll" ref={scroller} tabIndex={0} aria-label="文档滚动区" onScroll={() => {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = requestAnimationFrame(readScroll);
    }}>
      {view.width > 0 && <div className="document-preview-sheet" style={{ width: layout.width, height: layout.height }}>
        {layout.pages.slice(first, last + 1).map((box, offset) => <PdfPage key={first + offset} pdf={pdf} index={first + offset} box={box} layout={layout} view={view} density={density} onSize={storeRatio} />)}
      </div>}
    </div>
  </div>;
}

function PdfPage({ pdf, index, box, layout, view, density, onSize }: { pdf: PDFDocumentProxy; index: number; box: PdfPageBox; layout: PdfLayout; view: PdfViewport; density: number; onSize: (index: number, ratio: number) => void }) {
  const [page, setPage] = useState<PDFPageProxy>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFPageProxy | undefined;
    void pdf.getPage(index + 1).then((next) => { if (!cancelled) { loaded = next; setPage(next); } }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; loaded?.cleanup(); };
  }, [pdf, index]);
  useLayoutEffect(() => {
    if (!page) return;
    const { width, height } = page.getViewport({ scale: 1 });
    onSize(index, height / width);
  }, [page, onSize, index]);
  const tiles = page ? pdfTiles(layout.pageWidth, box.height, density, { ...view, top: view.top - box.top, left: view.left - layout.pageLeft }) : [];
  return <section className="document-preview-page" aria-label={`文档第 ${index + 1} 页`} style={{ top: box.top, left: layout.pageLeft, width: layout.pageWidth, height: box.height }}>
    {error && <div className="preview-error" role="alert">此页无法显示，请下载文件查看。</div>}
    {page && tiles.map((tile) => <PdfTile key={`${layout.pageWidth}:${density}:${tile.x}:${tile.y}:${tile.width}:${tile.height}`} page={page} width={layout.pageWidth} density={density} tile={tile} />)}
    {page && <PdfTextLayer page={page} width={layout.pageWidth} />}
  </section>;
}

function PdfTextLayer({ page, width }: { page: PDFPageProxy; width: number }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const viewport = useMemo(() => page.getViewport({ scale: 1 }), [page]);
  const scale = width / viewport.width;
  const sideways = viewport.rotation % 180 !== 0;

  useEffect(() => {
    const element = layerRef.current;
    if (!element) return;
    const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: element, viewport });
    element.style.removeProperty("width");
    element.style.removeProperty("height");
    void layer.render().catch(() => {});
    return () => {
      layer.cancel();
      element.replaceChildren();
    };
  }, [page, viewport]);

  return <div ref={layerRef} className="document-preview-text" style={{
    "--pdf-text-scale": viewport.userUnit * scale,
    "--pdf-text-width": `${(sideways ? viewport.height : viewport.width) * scale}px`,
    "--pdf-text-height": `${(sideways ? viewport.width : viewport.height) * scale}px`,
  } as CSSProperties} />;
}

function PdfTile({ page, width, density, tile }: { page: PDFPageProxy; width: number; density: number; tile: PdfTileBox }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const { x, y, width: tileWidth, height: tileHeight } = tile;

  useEffect(() => {
    const surface = canvas.current!;
    let cancelled = false;
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const renderTask = page.render({ canvas: surface, viewport, transform: [density, 0, 0, density, -x * density, -y * density], annotationMode: AnnotationMode.DISABLE });
    void renderTask.promise.then(() => { if (!cancelled) setReady(true); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      renderTask.cancel();
    };
  }, [page, width, density, x, y]);

  if (failed) return <div className="document-preview-tile preview-error" role="alert" style={{ left: x, top: y, width: tileWidth, height: tileHeight }}>此处无法显示，请下载文件查看。</div>;
  return <canvas ref={canvas} aria-hidden="true" hidden={!ready} className="document-preview-tile" width={Math.ceil(tileWidth * density)} height={Math.ceil(tileHeight * density)} style={{ left: x, top: y, width: tileWidth, height: tileHeight }} />;
}
