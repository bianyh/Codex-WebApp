import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const thread = { id: "capabilities", title: "Capabilities", cwd: "/tmp", status: "completed", model: "test-model", canRetry: true, runtimeSettings: { model: "test-model", effort: "medium", mode: "default" } };
const model = { id: "test", model: "test-model", displayName: "Test", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }, { reasoningEffort: "high", description: "" }], serviceTiers: [{ id: "priority", name: "Fast", description: "" }] };

async function open(page: Page) {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const mutations: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const actions: Record<string, unknown>[] = [];
  let send = (_event: unknown) => {};
  let queue = [{ id: "q1", text: "First queued", model: "test-model", attachments: [{ name: "note.txt", kind: "file", size: 4 }] }, { id: "q2", text: "Second queued", attachments: [] }];
  let snapshot = { thread: { ...thread }, items: [{ id: "u", kind: "user", text: "Initial prompt" }], pendingRequests: [], tokenUsage: { total: 90000, input: 80000, output: 10000, cachedInput: 70000, reasoningOutput: 2000, last: { total: 30000 }, modelContextWindow: 100000 } };
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (method !== "GET") mutations.push({ url: url.pathname, method, body: request.postDataJSON() ?? {} });
      if (url.pathname === "/api/auth/me") data = { authenticated: true };
      else if (url.pathname === "/api/models") data = [model];
      else if (url.pathname === "/api/threads") data = { threads: [snapshot.thread], nextCursor: url.searchParams.has("cursor") ? null : "next" };
      else if (url.pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (url.pathname.endsWith("/queue")) {
        if (method === "PATCH") { const body = request.postDataJSON(); if (body.action === "edit") queue = queue.map((entry) => entry.id === body.id ? { ...entry, text: body.text } : entry); if (body.action === "delete") queue = queue.filter((entry) => entry.id !== body.id); if (body.action === "reorder") queue = body.ids.map((id: string) => queue.find((entry) => entry.id === id)!); send({ type: "turn_queue_state", threadId: thread.id, queue }); } data = queue;
      } else if (url.pathname.endsWith("/compact")) { send({ type: "thread_event", threadId: thread.id, event: { method: "thread/compacted", params: {} } }); data = null; }
      else if (url.pathname.endsWith("/name")) { snapshot.thread.title = request.postDataJSON().name; data = null; }
      else if (url.pathname.endsWith("/fork")) data = { ...snapshot, thread: { ...snapshot.thread, id: "branch" } };
      else if (url.pathname === "/api/runtime/status") data = { quotas: { available: true, ordinaryUsageAllowed: false, entries: [{ id: "codex", name: "Codex", primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1800000000 } }] }, mcp: { available: true, entries: [{ id: "m", name: "Local MCP", status: "connected", toolCount: 3 }] }, skills: { available: true, entries: [{ id: "s", name: "Test skill", status: "enabled", path: "/tmp/SKILL.md" }] }, plugins: { available: false, error: "提供商不支持", entries: [] }, hooks: { available: true, entries: [{ id: "h", name: "sessionStart", status: "trusted" }] } };
      else if (url.pathname.startsWith("/api/threads/")) data = snapshot;
      else if (url.pathname === "/api/fs/list") data = { path: "/tmp", root: "/tmp", parent: null, entries: [] };
      await route.fulfill({ json: { ok: true, data } }); return;
    }
    const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
    try { await route.fulfill({ body: await readFile(path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd(), "dist/web", filename)), contentType }); } catch { await route.fulfill({ status: 404 }); }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    send = (event) => socket.send(JSON.stringify(event));
    socket.onMessage((raw) => { const action = JSON.parse(String(raw)); actions.push(action); if (action.type === "subscribe_thread") { send({ type: "thread_snapshot", snapshot: action.threadId === "branch" ? { ...snapshot, thread: { ...snapshot.thread, id: "branch" } } : snapshot }); send({ type: "turn_queue_state", threadId: action.threadId, queue }); } });
  });
  await page.goto(origin); await expect(page.locator(".user-message")).toContainText("Initial prompt");
  const panel = page.locator(".context-panel:visible");
  const tab = async (label: string) => { if ((await page.viewportSize())!.width < 1121) await page.getByRole("button", { name: "切换上下文侧栏", exact: true }).click(); await panel.getByRole("button", { name: label, exact: true }).click(); };
  return { errors, mutations, actions, emit: (event: unknown) => send(event), panel, tab };
}

test("queue edits preserve attachments and support reorder and cancellation", async ({ page }) => {
  const { panel, tab, mutations, errors } = await open(page); await tab("队列");
  await expect(panel).toContainText("First queued"); await expect(panel).toContainText("note.txt");
  await panel.getByRole("button", { name: "编辑指令 1", exact: true }).click();
  await panel.getByRole("textbox", { name: "编辑排队指令", exact: true }).fill("Edited queued");
  await panel.getByRole("button", { name: "保存指令", exact: true }).click();
  await expect(panel).toContainText("Edited queued"); await expect(panel).toContainText("note.txt");
  await panel.getByRole("button", { name: "下移指令 1", exact: true }).click();
  await expect(panel.locator(".queue-entry").first()).toContainText("Second queued");
  await panel.getByRole("button", { name: "取消指令 1", exact: true }).click();
  await expect(panel.locator(".queue-entry")).toHaveCount(1);
  expect(mutations.map((entry) => entry.body.action)).toEqual(["edit", "reorder", "delete"]); expect(errors).toEqual([]);
});

test("native next-turn settings and runtime rerouting remain distinct", async ({ page }) => {
  const { actions, emit, errors } = await open(page);
  await page.getByRole("button", { name: "下一轮执行设置", exact: true }).click();
  await page.getByLabel("推理强度", { exact: true }).selectOption("high");
  await page.getByLabel("服务速度", { exact: true }).selectOption("priority");
  await page.getByLabel("执行模式", { exact: true }).selectOption("plan");
  await page.locator(".composer textarea").fill("Use plan mode"); await page.getByRole("button", { name: "发送", exact: true }).click();
  expect(actions.at(-1)).toMatchObject({ type: "start_turn", model: "test-model", effort: "high", serviceTier: "priority", mode: "plan" });
  emit({ type: "thread_event", threadId: thread.id, event: { method: "model/rerouted", params: { fromModel: "test-model", toModel: "actual-model", reason: "capacity" } } });
  await expect(page.locator(".thread-meta")).toContainText("actual-model");
  await expect(page.getByLabel("消息模型", { exact: true })).toHaveValue("test-model"); expect(errors).toEqual([]);
});

test("cancelling a queued instruction removes its optimistic conversation message", async ({ page }) => {
  const { actions, emit, panel, tab, errors } = await open(page);
  emit({ type: "thread_activity", activity: { threadId: thread.id, status: "running", activitySource: "external", activeTurnId: "external-turn" } });
  await page.locator(".composer textarea").fill("First queued"); await page.getByRole("button", { name: "发送", exact: true }).click();
  expect(actions.at(-1)).toMatchObject({ type: "queue_turn", text: "First queued" });
  emit({ type: "turn_queued", threadId: thread.id, queuedId: "q1", text: "First queued" });
  await expect(page.locator(".queued-message-label")).toHaveText("待执行指令");
  await tab("队列"); await panel.getByRole("button", { name: "取消指令 1", exact: true }).click();
  await expect(page.locator(".queued-message-label")).toHaveCount(0);
  await expect(page.locator(".user-message")).toHaveCount(1); expect(errors).toEqual([]);
});

test("context pressure, safe compaction and read-only statuses work on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel, tab, emit, errors, mutations } = await open(page); await tab("Usage");
  await expect(panel.locator(".usage-total")).toHaveText("30%"); await expect(panel.getByRole("button", { name: "压缩上下文", exact: true })).toBeDisabled();
  emit({ type: "turn_queue_state", threadId: thread.id, queue: [] });
  page.once("dialog", (dialog) => dialog.accept()); await panel.getByRole("button", { name: "压缩上下文", exact: true }).click();
  await expect(panel).toContainText("上下文压缩完成");
  await panel.getByRole("button", { name: "状态", exact: true }).click();
  await expect(panel).toContainText("Local MCP"); await expect(panel).toContainText("Test skill"); await expect(panel).toContainText("sessionStart"); await expect(panel).toContainText("提供商不支持"); await expect(panel).toContainText("当前不允许");
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? "/tmp", "mobile-capabilities.png") });
  expect(mutations.some((entry) => entry.url.endsWith("/compact"))).toBe(true); expect(errors).toEqual([]);
});

test("rename, fork, archived list and restore are wired", async ({ page }) => {
  const { errors, mutations } = await open(page);
  await page.getByRole("button", { name: "线程操作", exact: true }).click();
  await page.getByLabel("线程名称", { exact: true }).fill("Renamed thread"); await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.locator(".topbar-title")).toContainText("Renamed thread");
  await page.getByRole("button", { name: "线程操作", exact: true }).click(); await page.getByRole("button", { name: "创建对话分支", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.locator(".drawer-bottom").getByRole("button", { name: "归档", exact: true }).click(); await expect(page.locator(".drawer-section-label")).toContainText("归档线程");
  await page.locator(".thread-row").first().click(); await page.getByRole("button", { name: "线程操作", exact: true }).click(); await page.getByRole("button", { name: "恢复归档线程", exact: true }).click();
  await expect(page.locator(".drawer-section-label")).toContainText("最近线程");
  expect(mutations.map((entry) => entry.url.split("/").at(-1))).toEqual(["name", "fork", "unarchive"]); expect(errors).toEqual([]);
});

test("structured agent, search, image and tool timing cards render safely", async ({ page }) => {
  const { emit, errors } = await open(page);
  const event = (item: unknown) => emit({ type: "thread_event", threadId: thread.id, event: { method: "item/completed", params: { item } } });
  event({ id: "a", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "Agent done" } } });
  event({ id: "s", type: "webSearch", query: "Codex docs", results: [{ url: "https://example.com", title: "Search result" }, { url: "javascript:alert(1)", title: "unsafe" }] });
  event({ id: "i", type: "imageGeneration", result: "data:image/png;base64,YWJj", status: "completed" });
  event({ id: "c", type: "commandExecution", command: "false", exitCode: 1, durationMs: 1500 });
  await page.getByRole("button", { name: /展开执行过程/ }).click();
  await expect(page.locator(".structured-card")).toHaveCount(3);
  await page.locator(".structured-card").first().locator("summary").click(); await expect(page.getByRole("button", { name: "打开子线程：child", exact: true })).toBeVisible();
  await page.locator(".structured-card").nth(1).locator("summary").click(); await expect(page.getByRole("link", { name: "Search result", exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: "unsafe", exact: true })).toHaveCount(0);
  await expect(page.locator(".tool-image")).toHaveAttribute("src", "data:image/png;base64,YWJj");
  await page.locator(".command-card summary").click(); await expect(page.locator(".tool-metadata")).toContainText("退出码 1"); expect(errors).toEqual([]);
});

test("tablet dark theme context drawer keeps queue controls accessible", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const { panel, tab, errors } = await open(page);
  await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await tab("队列"); await expect(panel.getByRole("button", { name: "编辑指令 1", exact: true })).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});
