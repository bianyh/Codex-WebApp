import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const threads = ["first", "second"].map((id) => ({ id, title: `Thread ${id}`, cwd: "/tmp", status: "completed", canRetry: true, model: "test-model" }));
const items = (id: string, count = 720) => Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, kind: index % 2 === 0 ? "user" : "agent", status: index % 2 ? "final_answer" : undefined, text: index === count - 1 ? `LATEST ${id}` : `History ${id} ${index}\n\n${"Content for a long conversation. ".repeat(5)}` }));
const model = { id: "test", model: "test-model", displayName: "Test model", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], serviceTiers: [{ id: "priority", name: "快速", description: "" }] };

async function openConsole(page: Page, { synchronousFirst = false } = {}) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const snapshots = new Map(threads.map((thread) => [thread.id, { thread, items: items(thread.id), pendingRequests: [] }]));
  const sockets: Array<{ send: (event: string) => void }> = [];
  const subscriptions: string[] = [];
  let delayed = false;
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (url.pathname === "/api/auth/me") data = { authenticated: true };
      else if (url.pathname === "/api/threads") data = { threads, nextCursor: null };
      else if (url.pathname === "/api/models") data = [model];
      else if (url.pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (url.pathname.startsWith("/api/threads/")) {
        const id = url.pathname.split("/").at(-1)!;
        if (id === "first" && !synchronousFirst && !delayed) { delayed = true; await new Promise((resolve) => setTimeout(resolve, 220)); }
        data = snapshots.get(id);
      } else if (url.pathname === "/api/fs/list") data = { path: "/tmp", root: "/tmp", parent: null, entries: [] };
      await route.fulfill({ json: { ok: true, data } }); return;
    }
    const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try { await route.fulfill({ body: await readFile(path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd(), "dist/web", filename)), contentType: filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream" }); } catch { await route.fulfill({ status: 404 }); }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      const action = JSON.parse(String(raw));
      if (action.type === "subscribe_thread") { subscriptions.push(action.threadId); socket.send(JSON.stringify({ type: "thread_snapshot", snapshot: snapshots.get(action.threadId) })); }
    });
  });
  await page.goto(origin);
  await expect.poll(() => subscriptions.includes("first")).toBe(true);
  const emit = (value: unknown) => sockets.at(-1)!.send(JSON.stringify(value));
  return { errors, emit, snapshots, subscriptions };
}

async function expectLatest(page: Page, id: string) {
  const timeline = page.locator(".timeline");
  await expect(timeline).toContainText(`LATEST ${id}`);
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(3);
  const latest = page.locator(".final-agent-message").last();
  const message = await latest.boundingBox(); const composer = await page.locator(".composer").boundingBox();
  expect(message!.y + message!.height).toBeLessThan(composer!.y + 1);
  expect(await page.locator(".message").count()).toBeLessThanOrEqual(240);
}

test("long history opens and reopens at latest on desktop and refresh", async ({ page }) => {
  const { errors } = await openConsole(page);
  await expectLatest(page, "first");
  await page.locator(".timeline").hover(); await page.mouse.wheel(0, -1400);
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Thread second/ }).click(); await expectLatest(page, "second");
  await page.getByRole("button", { name: /Thread first/ }).click(); await expectLatest(page, "first");
  await page.reload(); await expectLatest(page, "first"); expect(errors).toEqual([]);
});

test("same-thread hydration and new messages preserve a reader's scroll position", async ({ page }) => {
  const { emit, snapshots, errors } = await openConsole(page, { synchronousFirst: true });
  await expectLatest(page, "first");
  await page.locator(".timeline").hover(); await page.mouse.wheel(0, -1600);
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  const previous = await page.locator(".timeline").evaluate((element) => element.scrollTop);
  const snapshot = snapshots.get("first")!;
  emit({ type: "thread_snapshot", snapshot });
  emit({ type: "thread_event", threadId: "first", event: { method: "item/completed", params: { item: { id: "new-answer", type: "agentMessage", phase: "final_answer", text: "New final reply\n\n" + "More content. ".repeat(300) } } } });
  await expect(page.locator(".final-agent-message").last()).toContainText("New final reply");
  // Let font/resize settling run; it must have stopped on the user's wheel gesture.
  await expect.poll(() => page.locator(".timeline").evaluate((element, anchor) => Math.abs(element.scrollTop - anchor), previous)).toBeLessThan(3);
  await page.waitForTimeout(1700);
  expect(Math.abs((await page.locator(".timeline").evaluate((element) => element.scrollTop)) - previous)).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test("initial same-length snapshot relayout settles at the latest message", async ({ page }) => {
  const { emit, snapshots, errors } = await openConsole(page);
  await expectLatest(page, "first");
  const snapshot = structuredClone(snapshots.get("first")!);
  snapshot.items[snapshot.items.length - 3]!.text += "\n\n" + "Extra hydration content. ".repeat(200);
  emit({ type: "thread_snapshot", snapshot });
  await expectLatest(page, "first"); expect(errors).toEqual([]);
});

for (const width of [390, 768]) {
  test(`compact execution settings and latest entry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    const { errors } = await openConsole(page);
    await expectLatest(page, "first");
    const composer = page.locator(".composer");
    const height = (await composer.boundingBox())!.height;
    const trigger = page.getByRole("button", { name: "下一轮执行设置", exact: true });
    expect(await trigger.evaluate((element) => Boolean(element.closest(".composer-toolbar")))).toBe(true);
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "下一轮执行设置", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByLabel("推理强度", { exact: true }).selectOption("high");
    await panel.getByLabel("执行模式", { exact: true }).selectOption("plan");
    expect((await composer.boundingBox())!.height).toBe(height);
    const box = (await panel.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? "/tmp", `execution-popover-${width}.png`) });
    await panel.getByRole("button", { name: "完成", exact: true }).click(); await expect(panel).toHaveCount(0);
    await expect(trigger).toContainText("计划 · high");
    await trigger.click(); await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
    await trigger.click(); await panel.getByRole("button", { name: "恢复默认", exact: true }).click(); await expect(trigger).toContainText("执行设置");
    await page.locator(".composer textarea").click(); await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  });
}
