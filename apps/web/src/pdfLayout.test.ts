import { describe, expect, it } from "vitest";
import { pdfLayout, pdfPageAt, pdfTiles } from "./pdfLayout";

const view = { top: 0, left: 0, width: 390, height: 700 };

describe("PDF reader layout", () => {
  it("fits the available width, preserves varying aspect ratios and can align the last page", () => {
    const layout = pdfLayout(3, new Map([[1, 0.5]]), 1.5, view, 1);
    expect(layout.pageWidth).toBe(366);
    expect(layout.pages).toEqual([{ top: 12, height: 549 }, { top: 573, height: 183 }, { top: 768, height: 549 }]);
    expect(layout.height - view.height).toBe(768);
    expect(pdfPageAt(layout.pages, 550)).toBe(0);
    expect(pdfPageAt(layout.pages, 573)).toBe(1);
    expect(pdfPageAt(layout.pages, 900)).toBe(2);
  });

  it("uses bounded tiles at a high pixel density without reducing the render scale", () => {
    const tiles = pdfTiles(2400, 3500, 3, { ...view, left: 1000, top: 1100 });
    expect(tiles).not.toHaveLength(0);
    expect(tiles.some((tile) => tile.x <= 1000 && tile.x + tile.width > 1000 && tile.y <= 1100 && tile.y + tile.height > 1100)).toBe(true);
    expect(tiles.every((tile) => tile.width * 3 <= 1536 && tile.height * 3 <= 1536 && tile.x > 0 && tile.y > 0)).toBe(true);
    expect(pdfTiles(366, 549, 2, view)).toEqual([{ x: 0, y: 0, width: 366, height: 549 }]);
  });
});
