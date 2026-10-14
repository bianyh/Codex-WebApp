import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const thread = { id: "test-thread", title: "Protocol regression", cwd: "/tmp", status: "completed", canRetry: true };
const snapshot = { thread, items: [{ id: "user", kind: "user", text: "Original prompt" }, { id: "agent", kind: "agent", text: "Original answer", status: "final_answer" }], pendingRequests: [] };
const origin = "http://10.0.0.123:8787";

async function openConsole(page: Page, onSend: (action: Record<string, unknown>, emit: (value: unknown) => void) => void) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/api/")) {
      const data = pathname === "/api/auth/me" ? { authenticated: true } : pathname === "/api/threads" ? [thread] : pathname.endsWith("/goal") ? { goal: null, supported: true, canControl: true } : pathname.startsWith("/api/threads/") ? snapshot : pathname === "/api/models" ? [] : pathname === "/api/fs/list" ? { path: "/tmp", root: "/tmp", parent: null, entries: [] } : [];
      await route.fulfill({ json: { ok: true, data } });
      return;
    }
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    const buildDir = process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd();
    const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
    try { await route.fulfill({ body: await readFile(path.join(buildDir, "dist/web", filename)), contentType }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  let latestSocket: { send: (message: string) => void };
  let latestSnapshot = snapshot;
  const emit = (value: unknown) => {
    const event = value as { type?: string; snapshot?: typeof snapshot };
    if (event.type === "thread_snapshot" && event.snapshot) latestSnapshot = event.snapshot;
    latestSocket.send(JSON.stringify(value));
  };
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    latestSocket = socket;
    socket.onMessage((raw) => {
      const action = JSON.parse(String(raw));
      if (action.type === "subscribe_thread") socket.send(JSON.stringify({ type: "thread_snapshot", snapshot: latestSnapshot }));
      else onSend(action, emit);
    });
  });
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "编辑并重新发送最近消息", exact: true })).toBeVisible();
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  return errors;
}

async function resend(page: Page) {
  await page.getByRole("button", { name: "编辑并重新发送最近消息", exact: true }).click();
  await page.locator("textarea").fill("Revised prompt");
  await page.locator("textarea").press("Control+Enter");
}

test("failed resend over LAN HTTP shows an error without blanking the app", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openConsole(page, (_action, emit) => emit({ type: "error", threadId: thread.id, error: { code: "action_failed", message: "Rollback failed" } }));
  await resend(page);
  await expect(page.locator(".timeline-error-card")).toContainText("Rollback failed");
  await expect(page.locator("textarea")).toHaveValue("Revised prompt");
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(errors).toEqual([]);
});

test("legacy resend follows its replacement branch and receives the final reply", async ({ page }) => {
  const errors = await openConsole(page, (_action, emit) => {
    const replacement = { ...thread, id: "branch" };
    emit({ type: "thread_snapshot", replacesThreadId: thread.id, snapshot: { thread: replacement, items: [], pendingRequests: [] } });
    emit({ type: "thread_event", threadId: replacement.id, event: { method: "turn/started", params: { turn: { id: "new-turn" } } } });
    emit({ type: "thread_event", threadId: replacement.id, event: { method: "item/completed", params: { item: { id: "new-user", type: "userMessage", content: [{ type: "text", text: "Revised prompt" }] } } } });
    emit({ type: "thread_event", threadId: replacement.id, event: { method: "item/completed", params: { item: { id: "new-agent", type: "agentMessage", text: "Revised answer", phase: "final_answer" } } } });
    emit({ type: "thread_event", threadId: replacement.id, event: { method: "turn/completed", params: { turn: { id: "new-turn", status: "completed" } } } });
  });
  await resend(page);
  await expect(page.locator(".final-agent-message")).toContainText("Revised answer");
  await expect(page.locator(".user-message")).toContainText("Revised prompt");
  expect(errors).toEqual([]);
});

test("current plan, nested token usage and structured file changes render safely", async ({ page }) => {
  const errors = await openConsole(page, (_action, emit) => {
    const event = (method: string, params: unknown) => emit({ type: "thread_event", threadId: thread.id, event: { method, params } });
    event("turn/plan/updated", { plan: [{ step: "Inspect protocol", status: "completed" }] });
    event("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 150, inputTokens: 100, outputTokens: 50 }, last: {} } });
    event("item/completed", { item: { type: "fileChange", id: "file", status: "completed", changes: [{ path: "/tmp/test.ts", kind: { type: "update", move_path: null }, diff: "test diff" }] } });
  });
  await resend(page);
  await expect(page.locator(".context-desktop .plan-step")).toContainText("Inspect protocol");
  await expect(page.locator(".context-desktop .step-check")).toHaveClass(/completed/);
  await page.locator(".context-desktop").getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.locator(".context-desktop .usage-row").filter({ hasText: "总量" })).toContainText("150");
  await page.locator(".context-desktop").getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(errors).toEqual([]);
});
