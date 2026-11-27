import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

const thread = { id: "upload-thread", title: "File upload", status: "completed", cwd: "/tmp" };
const snapshot = { thread, items: [], pendingRequests: [] };
const filename = "大文件.bin";
const bytes = 26 * 1024 * 1024;

async function openApp(page: Page, endpoint: string, expectedFiles = [{ name: filename, size: bytes, type: "application/octet-stream" }]) {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const build = path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd(), "dist/web");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === endpoint) {
      let received = 0;
      try { for await (const chunk of request) received += chunk.length; }
      catch { return; }
      await pending;
      const file = expectedFiles.find(({ name }) => name === url.searchParams.get("name"));
      if (!file || request.headers["content-type"] !== "application/octet-stream" || received !== file.size ||
          (endpoint === "/api/fs/upload" && url.searchParams.get("path") !== "/tmp") ||
          (endpoint === "/api/uploads" && url.searchParams.get("mime") !== file.type)) {
        response.writeHead(400).end();
        return;
      }
      const data = endpoint === "/api/uploads"
        ? { id: file.name, name: file.name, path: "/tmp/" + file.name, kind: file.type.startsWith("image/") ? "image" : "file", mime: file.type, size: received }
        : { name: file.name, path: "/tmp/" + file.name, type: "file", kind: "binary", size: received, hidden: false };
      response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, data }));
    } else if (url.pathname.startsWith("/api/")) {
      const data = url.pathname === "/api/auth/me" ? { authenticated: true }
        : url.pathname === "/api/threads" ? [thread]
        : url.pathname.endsWith("/goal") ? { goal: null, supported: true, canControl: true }
        : url.pathname.startsWith("/api/threads/") ? snapshot
        : url.pathname === "/api/fs/list" ? { path: "/tmp", root: "/", parent: "/", entries: [] }
        : [];
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, data }));
    } else {
      const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
      try {
        const body = await readFile(path.join(build, filename));
        response.writeHead(200, { "Content-Type": contentType }).end(body);
      } catch { response.writeHead(404).end(); }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  page.once("close", () => { finish(); server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await page.routeWebSocket(origin.replace("http:", "ws:") + "/ws", (socket) => socket.onMessage((message) => {
    if (JSON.parse(String(message)).type === "subscribe_thread") socket.send(JSON.stringify({ type: "thread_snapshot", snapshot }));
  }));
  await page.goto(origin);
  return finish;
}

test("Files uploads above 25 MiB show transfer progress until saved", async ({ page }) => {
  const finish = await openApp(page, "/api/fs/upload");
  try {
    const sidebar = page.locator(".context-desktop");
    await sidebar.getByRole("button", { name: "Files", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "上传文件到当前目录" })).toBeEnabled();
    await sidebar.locator("input[type=file]").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: Buffer.alloc(bytes) });
    const progress = sidebar.getByRole("progressbar", { name: "文件上传进度" });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("max", String(bytes));
    await expect(progress).toHaveAttribute("value", String(bytes));
    await expect(sidebar.getByText(/等待服务器确认/)).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /^大文件\.bin/ })).toHaveCount(0);
  } finally { finish(); }
  await expect(page.getByRole("progressbar", { name: "文件上传进度" })).toHaveCount(0);
  await expect(page.locator(".context-desktop").getByRole("button", { name: /^大文件\.bin/ })).toBeVisible();
});

test("a large chat attachment waits for confirmation before becoming sendable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const finish = await openApp(page, "/api/uploads");
  try {
    await expect(page.getByRole("button", { name: "添加图片或文件" })).toBeVisible();
    await page.locator(".attachment-input").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: Buffer.alloc(bytes) });
    const progress = page.getByRole("progressbar", { name: "文件上传进度" });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("value", String(bytes));
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  } finally { finish(); }
  await expect(page.getByRole("progressbar", { name: "文件上传进度" })).toHaveCount(0);
  await expect(page.getByLabel("已添加附件").getByText(filename)).toBeVisible();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
});

test("the composer accepts multiple dropped files and keeps text drags native", async ({ page }) => {
  const files = [{ name: "照片.png", size: 24, type: "image/png" }, { name: "说明.txt", size: 8, type: "text/plain" }];
  const finish = await openApp(page, "/api/uploads", files);
  const composer = page.locator(".composer");
  const input = composer.locator("textarea");
  try {
    await input.fill("Keep this draft");
    const textDragPrevented = await input.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", "Text drag");
      const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(textDragPrevented).toBe(false);
    await expect(composer.getByText("松开以上传为对话附件")).toHaveCount(0);
    const dataTransfer = await page.evaluateHandle((files) => {
      const transfer = new DataTransfer();
      for (const { name, size, type } of files) transfer.items.add(new File([new Uint8Array(size)], name, { type }));
      return transfer;
    }, files);
    await composer.dispatchEvent("dragenter", { dataTransfer });
    await input.dispatchEvent("dragenter", { dataTransfer });
    await composer.dispatchEvent("dragleave", { dataTransfer });
    await expect(composer.getByText("松开以上传为对话附件")).toBeVisible();
    await input.dispatchEvent("dragover", { dataTransfer });
    await input.dispatchEvent("drop", { dataTransfer });
    await expect(composer.getByText("松开以上传为对话附件")).toHaveCount(0);
    await expect(composer.getByRole("progressbar")).toBeVisible();
    await expect(input).toHaveValue("Keep this draft");
  } finally { finish(); }
  const attachments = composer.getByLabel("已添加附件");
  await expect(attachments.getByText("照片.png")).toBeVisible();
  await expect(attachments.getByText("说明.txt")).toBeVisible();
  await expect(composer.getByRole("progressbar")).toHaveCount(0);
});

test("dropping onto the Files upload button saves to the current directory", async ({ page }) => {
  const files = [{ name: "拖入.txt", size: 12, type: "text/plain" }];
  const finish = await openApp(page, "/api/fs/upload", files);
  const sidebar = page.locator(".context-desktop");
  const upload = sidebar.getByRole("button", { name: "上传文件到当前目录" });
  try {
    await sidebar.getByRole("button", { name: "Files", exact: true }).click();
    await expect(upload).toBeEnabled();
    const dataTransfer = await page.evaluateHandle(({ name, size, type }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(size)], name, { type }));
      return transfer;
    }, files[0]!);
    await upload.dispatchEvent("dragenter", { dataTransfer });
    await expect(sidebar.getByText("松开以上传到当前目录")).toBeVisible();
    await upload.dispatchEvent("dragleave", { dataTransfer });
    await expect(sidebar.getByText("松开以上传到当前目录")).toHaveCount(0);
    await upload.dispatchEvent("dragenter", { dataTransfer });
    await upload.dispatchEvent("drop", { dataTransfer });
    await expect(sidebar.getByRole("progressbar")).toBeVisible();
  } finally { finish(); }
  await expect(sidebar.getByRole("button", { name: /^拖入\.txt/ })).toBeVisible();
  await expect(sidebar.getByRole("progressbar")).toHaveCount(0);
});
