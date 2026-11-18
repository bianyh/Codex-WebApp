const gap = 12;

export type PdfViewport = { top: number; left: number; width: number; height: number };
export type PdfPageBox = { top: number; height: number };
export type PdfTileBox = { x: number; y: number; width: number; height: number };

export function pdfLayout(count: number, aspectRatios: ReadonlyMap<number, number>, fallback: number, view: PdfViewport, zoom: number) {
  const pageWidth = Math.max(1, Math.round((view.width - 2 * gap) * zoom));
  const width = Math.max(view.width, pageWidth + 2 * gap);
  let top = gap;
  const pages = Array.from({ length: count }, (_, index) => {
    const height = Math.max(1, Math.round(pageWidth * (aspectRatios.get(index) ?? fallback)));
    const box = { top, height };
    top += height + gap;
    return box;
  });
  return { pages, pageWidth, pageLeft: (width - pageWidth) / 2, width, height: Math.max(top, (pages.at(-1)?.top ?? 0) + view.height) };
}

export function pdfPageAt(pages: PdfPageBox[], offset: number): number {
  let first = 0;
  let last = pages.length - 1;
  while (first < last) {
    const mid = Math.floor((first + last) / 2);
    const page = pages[mid]!;
    if (offset < page.top + page.height) last = mid;
    else first = mid + 1;
  }
  return first;
}

export function pdfTiles(width: number, height: number, density: number, window: PdfViewport): PdfTileBox[] {
  if (width * height * density ** 2 <= 4_000_000 && Math.max(width, height) * density <= 4096) return [{ x: 0, y: 0, width, height }];
  const tileSize = Math.floor(1536 / density);
  const endX = Math.min(width, window.left + window.width + 80);
  const endY = Math.min(height, window.top + window.height + 80);
  const tiles: PdfTileBox[] = [];
  for (let y = Math.max(0, Math.floor((window.top - 80) / tileSize) * tileSize); y < endY; y += tileSize) {
    for (let x = Math.max(0, Math.floor((window.left - 80) / tileSize) * tileSize); x < endX; x += tileSize) {
      tiles.push({ x, y, width: Math.min(tileSize, width - x), height: Math.min(tileSize, height - y) });
    }
  }
  return tiles;
}
