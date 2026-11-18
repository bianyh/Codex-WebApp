import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const pdfPath = "/tmp/接口 实测.pdf";
const wordPath = "/tmp/会议记录.docx";
const presentationPath = "/tmp/项目演示.pptx";
const legacyPresentationPath = "/tmp/旧版演示.ppt";
const thread = { id: "file-preview-thread", title: "Documents", status: "completed", cwd: "/tmp" };
const snapshot = { thread, pendingRequests: [], items: [{ id: "reply", kind: "agent", status: "final_answer", text: `[PDF 第五页](<${pdfPath}#page=5>)\n\n[Word 旧格式](file:///tmp/报告.doc)\n\n[PPT 旧格式](<${legacyPresentationPath}>)` }] };

function makePdf(pageCount: number) {
  const pages = Array.from({ length: pageCount }, (_unused, index) => 3 + index * 2);
  const font = 3 + 2 * pageCount;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  for (const [index, page] of pages.entries()) {
    const content = `${index === 4 ? "1 0 0" : "0 0 1"} rg 0 0 100 140 re f\n1 1 1 rg BT /F1 7 Tf 9 98 Td (Slide ${index + 1} selectable text) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 140] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${page + 1} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const table = ["0000000000 65535 f \n"];
  for (const [index, object] of objects.entries()) {
    table.push(`${String(body.length).padStart(10, "0")} 00000 n \n`);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return Buffer.from(`${body}xref\n0 ${table.length}\n${table.join("")}trailer\n<< /Size ${table.length} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`);
}

async function openConsole(page: Page, converterAvailable = true, pageCount = 6) {
  const documentRequests: string[] = [];
  const buildDir = process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd();
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/fs/raw" || pathname === "/api/fs/word-preview" || pathname === "/api/fs/presentation-preview") {
      documentRequests.push(url.searchParams.get("path") ?? "");
      if (pathname.endsWith("-preview") && !converterAvailable) {
        await route.fulfill({ status: 503, json: { ok: false, error: { message: "服务器未配置 LibreOffice" } } });
      } else await route.fulfill({ body: makePdf(pageCount), contentType: "application/pdf" });
    } else if (pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (pathname === "/api/auth/me") data = { authenticated: true };
      else if (pathname === "/api/threads") data = [thread];
      else if (pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (pathname.startsWith("/api/threads/")) data = snapshot;
      else if (pathname === "/api/fs/list") data = { path: "/tmp", root: "/", parent: "/", entries: [
        { name: "会议记录.docx", path: wordPath, type: "file", kind: "word", size: 1024, hidden: false },
        { name: "项目演示.pptx", path: presentationPath, type: "file", kind: "presentation", size: 1024, hidden: false },
      ] };
      await route.fulfill({ json: { ok: true, data } });
    } else {
      const filename = pathname === "/" ? "index.html" : pathname.slice(1);
      const contentType = /\.m?js$/.test(filename) ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
      try { await route.fulfill({ body: await readFile(path.join(buildDir, "dist/web", filename)), contentType }); }
      catch { await route.fulfill({ status: 404 }); }
    }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    socket.onMessage((message) => {
      if (JSON.parse(String(message)).type === "subscribe_thread") socket.send(JSON.stringify({ type: "thread_snapshot", snapshot }));
    });
  });
  await page.goto(origin);
  return documentRequests;
}

test("a mobile PDF link opens the specified page and supports continuous scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = await openConsole(page);
  await page.getByRole("link", { name: "PDF 第五页" }).click();
  const dialog = page.getByRole("dialog");
  const canvas = dialog.getByRole("region", { name: "文档第 5 页" }).locator("canvas:visible").first();
  await expect(canvas).toBeInViewport();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(10, 10, 1, 1).data))).toEqual([255, 0, 0, 255]);
  expect(requests).toEqual([pdfPath]);
  await expect(dialog.getByText("第 5 / 6 页", { exact: true })).toBeVisible();
  const reader = dialog.getByLabel("文档滚动区");
  const current = dialog.getByRole("region", { name: "文档第 5 页" });
  const height = await current.evaluate((element) => element.clientHeight);
  await reader.hover();
  await page.mouse.wheel(0, height + 12);
  await expect(dialog.getByText("第 6 / 6 页", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "上一页" }).click();
  await expect(dialog.getByText("第 5 / 6 页", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test.describe("high-density PDF rendering", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  test("zoom increases the rendered resolution, preserves the page and bounds mounted pages", async ({ page }) => {
    await openConsole(page, true, 120);
    await page.getByRole("link", { name: "PDF 第五页" }).click();
    const dialog = page.getByRole("dialog");
    const reader = dialog.getByLabel("文档滚动区");
    const current = dialog.getByRole("region", { name: "文档第 5 页" });
    const canvas = current.locator("canvas:visible");
    await expect(canvas).toHaveCount(1);
    const pixels = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
    const fitWidth = await current.evaluate((element) => element.clientWidth);
    expect(fitWidth).toBeGreaterThanOrEqual(350);
    expect(pixels).toBe(fitWidth * 2);
    await dialog.getByRole("button", { name: "放大" }).click();
    await expect(dialog.getByRole("button", { name: "适应宽度" })).toHaveText("125%");
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(pixels);
    await expect(dialog.getByText("第 5 / 120 页", { exact: true })).toBeVisible();
    expect(await reader.evaluate((element) => element.scrollWidth)).toBeGreaterThan(fitWidth + 24);

    for (let step = 0; step < 5; step++) await dialog.getByRole("button", { name: "放大" }).click();
    await expect(dialog.getByRole("button", { name: "适应宽度" })).toHaveText("400%");
    const rightTile = current.locator("canvas:visible").last();
    await expect.poll(() => rightTile.evaluate((element: HTMLCanvasElement) => [parseFloat(element.style.left) > 0, element.width === element.clientWidth * 2, ...element.getContext("2d")!.getImageData(10, 10, 1, 1).data])).toEqual([true, true, 255, 0, 0, 255]);
    expect(await dialog.locator(".document-preview-page").count()).toBeLessThan(8);
    await dialog.getByRole("button", { name: "适应宽度" }).click();
    await expect(dialog.getByRole("button", { name: "适应宽度" })).toHaveText("100%");
    await expect(dialog.getByText("第 5 / 120 页", { exact: true })).toBeVisible();
    expect(await current.evaluate((element) => element.clientWidth)).toBe(fitWidth);
  });
});

test("a DOCX selected in Files renders inline and downloads the original", async ({ page }) => {
  const requests = await openConsole(page);
  await page.locator(".context-desktop").getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /^会议记录\.docx/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "文档第 1 页" }).locator("canvas:visible").first()).toBeInViewport();
  await expect(dialog.getByRole("link", { name: "下载" })).toHaveAttribute("href", `/api/fs/raw?path=${encodeURIComponent(wordPath)}`);
  expect(requests).toEqual([wordPath]);
});

test("a Word link reports converter errors and keeps the original download available", async ({ page }) => {
  const requests = await openConsole(page, false);
  await page.getByRole("link", { name: "Word 旧格式" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("服务器未配置 LibreOffice");
  await expect(dialog.getByRole("link", { name: "下载" })).toHaveAttribute("download", "报告.doc");
  expect(requests).toEqual(["/tmp/报告.doc"]);
});

test("PowerPoint conversion starts without waiting for the PDF reader bundle", async ({ page }) => {
  const requests = await openConsole(page);
  const releaseBundle = Promise.withResolvers<void>();
  await page.route(/\/assets\/DocumentPreview-[^/]+\.js$/, async (route) => {
    await releaseBundle.promise;
    await route.fallback();
  });
  try {
    await page.getByRole("link", { name: "PPT 旧格式" }).click();
    await expect.poll(() => requests).toEqual([legacyPresentationPath]);
  } finally {
    releaseBundle.resolve();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "文档第 1 页" }).locator("canvas:visible").first()).toBeInViewport();
  expect(requests).toEqual([legacyPresentationPath]);
});

test("PowerPoint files open from both the Files panel and conversation links", async ({ page }) => {
  const requests = await openConsole(page, true, 2);
  await page.locator(".context-desktop").getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /^项目演示\.pptx/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "文档第 1 页" }).locator("canvas:visible").first()).toBeInViewport();
  await dialog.getByRole("button", { name: "下一页" }).click();
  await expect(dialog.getByText("第 2 / 2 页", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "放大" }).click();
  await expect(dialog.getByRole("button", { name: "适应宽度" })).toHaveText("125%");
  await expect(dialog.getByRole("link", { name: "下载" })).toHaveAttribute("href", `/api/fs/raw?path=${encodeURIComponent(presentationPath)}`);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "PPT 旧格式" }).click();
  await expect(dialog.getByRole("region", { name: "文档第 1 页" }).locator("canvas:visible").first()).toBeInViewport();
  await expect(dialog.getByRole("link", { name: "下载" })).toHaveAttribute("download", "旧版演示.ppt");
  expect(requests).toEqual([presentationPath, legacyPresentationPath]);
});

test("PowerPoint text can be selected and copied from the slide at a non-default zoom", async ({ page }) => {
  await openConsole(page, true, 2);
  await page.getByRole("link", { name: "PPT 旧格式" }).click();
  await page.getByRole("button", { name: "缩小" }).click();
  const slide = page.getByRole("region", { name: "文档第 1 页" });
  const text = slide.getByText("Slide 1 selectable text", { exact: true });
  await expect(text).toBeInViewport();
  const box = (await text.boundingBox())!;
  const middle = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, middle);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, middle, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Slide 1 selectable text");
  await page.keyboard.press("Control+c");
  const paste = page.locator("#copy-verification");
  await page.evaluate(() => {
    const input = document.createElement("textarea");
    input.id = "copy-verification";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("Control+v");
  await expect(paste).toHaveValue("Slide 1 selectable text");
});

test("Ctrl-wheel zooms continuously around the pointer without browser zoom", async ({ page }) => {
  await openConsole(page);
  await page.getByRole("link", { name: "PDF 第五页" }).click();
  const dialog = page.getByRole("dialog");
  const slide = dialog.getByRole("region", { name: "文档第 5 页" });
  await expect(slide.locator("canvas:visible").first()).toBeInViewport();
  const area = dialog.getByLabel("文档滚动区");
  const point = { x: 400, y: 240 };
  const dimensions = (await area.boundingBox())!;
  const position = async () => {
    const box = (await slide.boundingBox())!;
    return { x: (dimensions.x + point.x - box.x) / box.width, y: (dimensions.y + point.y - box.y) / box.height };
  };
  const before = await position();
  const originalViewport = await page.evaluate(() => [innerWidth, devicePixelRatio]);
  const zoom = dialog.getByRole("button", { name: "适应宽度" });
  await area.hover({ position: point });
  await page.keyboard.down("Control");
  try {
    await page.mouse.wheel(0, -40);
    await expect(zoom).toHaveText("111%");
    const after = await position();
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
    await page.mouse.wheel(0, 22);
    await expect(zoom).toHaveText("105%");
  } finally {
    await page.keyboard.up("Control");
  }
  expect(await page.evaluate(() => [innerWidth, devicePixelRatio])).toEqual(originalViewport);
});
