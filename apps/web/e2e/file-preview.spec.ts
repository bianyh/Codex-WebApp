import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const pdfPath = "/tmp/接口 实测.pdf";
const wordPath = "/tmp/会议记录.docx";
const thread = { id: "file-preview-thread", title: "Documents", status: "completed", cwd: "/tmp" };
const snapshot = { thread, pendingRequests: [], items: [{ id: "reply", kind: "agent", status: "final_answer", text: `[PDF 第五页](<${pdfPath}#page=5>)\n\n[Word 旧格式](file:///tmp/报告.doc)` }] };

function makePdf() {
  const pages = Array.from({ length: 6 }, (_unused, index) => 3 + index * 2);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  for (const [index, page] of pages.entries()) {
    const content = `${index === 4 ? "1 0 0" : "0 0 1"} rg 0 0 100 140 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 140] /Contents ${page + 1} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  let body = "%PDF-1.4\n";
  const table = ["0000000000 65535 f \n"];
  for (const [index, object] of objects.entries()) {
    table.push(`${String(body.length).padStart(10, "0")} 00000 n \n`);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return Buffer.from(`${body}xref\n0 ${table.length}\n${table.join("")}trailer\n<< /Size ${table.length} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`);
}

async function openConsole(page: Page, converterAvailable = true) {
  const documentRequests: string[] = [];
  const buildDir = process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd();
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/fs/raw" || pathname === "/api/fs/word-preview") {
      documentRequests.push(url.searchParams.get("path") ?? "");
      if (pathname.endsWith("word-preview") && !converterAvailable) {
        await route.fulfill({ status: 503, json: { ok: false, error: { message: "服务器未配置 LibreOffice" } } });
      } else await route.fulfill({ body: makePdf(), contentType: "application/pdf" });
    } else if (pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (pathname === "/api/auth/me") data = { authenticated: true };
      else if (pathname === "/api/threads") data = [thread];
      else if (pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (pathname.startsWith("/api/threads/")) data = snapshot;
      else if (pathname === "/api/fs/list") data = { path: "/tmp", root: "/", parent: "/", entries: [{ name: "会议记录.docx", path: wordPath, type: "file", kind: "word", size: 1024, hidden: false }] };
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

test("a mobile PDF link renders page five without passing its fragment to the server", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = await openConsole(page);
  await page.getByRole("link", { name: "PDF 第五页" }).click();
  const dialog = page.getByRole("dialog");
  const canvas = dialog.getByRole("img", { name: "文档第 5 页" });
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(10, 10, 1, 1).data))).toEqual([255, 0, 0, 255]);
  expect(requests).toEqual([pdfPath]);
  await dialog.getByRole("button", { name: "上一页" }).click();
  await expect(dialog.getByRole("img", { name: "文档第 4 页" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a DOCX selected in Files renders inline and downloads the original", async ({ page }) => {
  const requests = await openConsole(page);
  await page.locator(".context-desktop").getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: /^会议记录\.docx/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: "文档第 1 页" })).toBeVisible();
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
