import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const source = { id: "source", title: "Original conversation", cwd: "/tmp", status: "completed", canRetry: true, model: "model-a" };
const items = [1, 2, 3].flatMap((index) => [
  { id: `u${index}`, turnId: `t${index}`, kind: "user", text: `Prompt ${index}` },
  { id: `a${index}`, turnId: `t${index}`, kind: "agent", status: "final_answer", text: `Answer ${index}` },
]);
const model = (id: string) => ({ id, model: id, displayName: id, isDefault: id === "model-a", inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] });

async function open(page: Page, { fail = false, hold = false }: { fail?: boolean; hold?: boolean } = {}) {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const branches: Record<string, unknown>[] = []; const actions: Record<string, unknown>[] = [];
  const snapshots = new Map<string, { thread: typeof source; items: typeof items; pendingRequests: never[] }>([[source.id, { thread: { ...source }, items: structuredClone(items), pendingRequests: [] }]]);
  let release!: () => void;
  const gate = hold ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  let emit = (_event: unknown) => {};
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (url.pathname === "/api/auth/me") data = { authenticated: true };
      else if (url.pathname === "/api/models") data = [model("model-a"), model("model-b")];
      else if (url.pathname === "/api/threads") data = { threads: [...snapshots.values()].map((value) => value.thread), nextCursor: null };
      else if (url.pathname.endsWith("/fork")) {
        const body = request.postDataJSON(); branches.push(body); await gate;
        if (fail) { await route.fulfill({ status: 409, json: { ok: false, error: { message: "Selected turn no longer exists" } } }); return; }
        const index = body.beforeTurnId ? Number(body.beforeTurnId.slice(1)) - 1 : body.lastTurnId ? Number(body.lastTurnId.slice(1)) : 3;
        const fork = { thread: { ...source, id: "branch", title: "New branch" }, items: items.slice(0, Math.max(0, index * 2)), pendingRequests: [] as never[] };
        snapshots.set("branch", fork); data = fork;
      } else if (url.pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (url.pathname.startsWith("/api/threads/")) data = snapshots.get(url.pathname.split("/").at(-1)!);
      else if (url.pathname === "/api/fs/list") data = { path: "/tmp", root: "/", parent: "/", entries: [] };
      await route.fulfill({ json: { ok: true, data } }); return;
    }
    const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try { await route.fulfill({ body: await readFile(path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd(), "dist/web", filename)), contentType: filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    emit = (event) => socket.send(JSON.stringify(event));
    socket.onMessage((raw) => { const action = JSON.parse(String(raw)); if (action.type === "subscribe_thread") emit({ type: "thread_snapshot", snapshot: snapshots.get(action.threadId) }); else actions.push(action); });
  });
  await page.goto(origin);
  await expect(page.locator(".final-agent-message").last()).toContainText("Answer 3");
  return { errors, branches, actions, release, emit: (value: unknown) => emit(value), snapshots };
}

const branchAt = (page: Page, itemId: string) => page.locator(`[data-item-id="${itemId}"]`).getByRole("button", { name: "从这里创建分支", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "从这里创建分支", exact: true });

test("forks before an older user message, restores its draft and sends into the new thread", async ({ page }) => {
  const { branches, actions, errors } = await open(page);
  await page.getByLabel("消息模型", { exact: true }).selectOption("model-b");
  await page.getByRole("button", { name: "下一轮执行设置", exact: true }).click();
  await page.getByLabel("推理强度", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await branchAt(page, "u2").click();
  await expect(dialog(page).getByRole("radio", { name: /从这轮之前重新提问/ })).toBeChecked();
  await dialog(page).getByRole("button", { name: "创建并打开分支", exact: true }).click();
  await expect(page.locator(".topbar-title")).toContainText("New branch");
  expect(branches).toEqual([{ beforeTurnId: "t2" }]);
  await expect(page.locator(".timeline")).toContainText("Answer 1");
  await expect(page.locator(".timeline")).not.toContainText("Answer 2");
  await expect(page.locator(".composer textarea")).toHaveValue("Prompt 2");
  await expect(page.getByLabel("消息模型", { exact: true })).toHaveValue("model-b");
  expect(actions).toEqual([]);
  await page.locator(".composer textarea").fill("A different direction");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => actions.at(-1)).toMatchObject({ type: "start_turn", threadId: "branch", text: "A different direction", model: "model-b", effort: "high" });
  await page.getByRole("button", { name: /Original conversation/ }).click();
  await expect(page.locator(".final-agent-message").last()).toContainText("Answer 3");
  expect(errors).toEqual([]);
});

test("forks through an older final answer and excludes later conversation", async ({ page }) => {
  const { branches, errors } = await open(page);
  await branchAt(page, "a1").click();
  await expect(dialog(page).getByRole("radio", { name: /保留这轮并继续/ })).toBeChecked();
  await dialog(page).getByRole("button", { name: "创建并打开分支", exact: true }).click();
  await expect(page.locator(".topbar-title")).toContainText("New branch");
  expect(branches).toEqual([{ lastTurnId: "t1" }]);
  await expect(page.locator(".user-message")).toHaveCount(1);
  await expect(page.locator(".final-agent-message")).toContainText("Answer 1");
  await expect(page.locator(".composer textarea")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("branching before the first turn creates an empty conversation with an unsent draft", async ({ page }) => {
  const { branches, actions, errors } = await open(page);
  await branchAt(page, "a1").click();
  await dialog(page).getByRole("radio", { name: /从这轮之前重新提问/ }).check();
  await dialog(page).getByRole("button", { name: "创建并打开分支", exact: true }).click();
  await expect(page.locator(".topbar-title")).toContainText("New branch");
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toHaveValue("Prompt 1");
  expect(branches).toEqual([{ beforeTurnId: "t1" }]); expect(actions).toEqual([]); expect(errors).toEqual([]);
});

test("failed forks keep the source, draft and selected boundary intact", async ({ page }) => {
  const { branches, errors } = await open(page, { fail: true });
  await page.locator(".composer textarea").fill("Unsent source draft");
  await branchAt(page, "u2").click();
  await dialog(page).getByRole("button", { name: "创建并打开分支", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Selected turn no longer exists");
  await expect(dialog(page).getByRole("radio", { name: /从这轮之前重新提问/ })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toHaveValue("Unsent source draft");
  await expect(page.locator(".topbar-title")).toContainText("Original conversation");
  expect(branches).toEqual([{ beforeTurnId: "t2" }]); expect(errors).toEqual([]);
});

test("pending forks are deduplicated and active or queued turns cannot be branched", async ({ page }) => {
  const { branches, release, emit, errors } = await open(page, { hold: true });
  emit({ type: "thread_activity", activity: { threadId: "source", status: "running", activeTurnId: "live", canInterrupt: true } });
  await expect(branchAt(page, "u1")).toBeDisabled();
  emit({ type: "thread_activity", activity: { threadId: "source", status: "completed" } });
  emit({ type: "turn_queue_state", threadId: "source", queue: [{ id: "queued", text: "wait", attachments: [] }] });
  await expect(branchAt(page, "u1")).toBeDisabled();
  emit({ type: "turn_queue_state", threadId: "source", queue: [] });
  await expect(branchAt(page, "u1")).toBeEnabled();
  await branchAt(page, "u1").click();
  await dialog(page).getByRole("button", { name: "创建并打开分支", exact: true }).evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(() => branches.length).toBe(1);
  await expect(dialog(page).getByRole("button", { name: "正在创建…", exact: true })).toBeDisabled();
  release(); await expect(page.locator(".topbar-title")).toContainText("New branch"); expect(errors).toEqual([]);
});

test("live item events retain their turn boundary without requiring a refresh", async ({ page }) => {
  const { branches, emit, errors } = await open(page);
  emit({ type: "thread_event", threadId: "source", event: { method: "turn/started", params: { turn: { id: "t4" } } } });
  emit({ type: "thread_event", threadId: "source", event: { method: "item/completed", params: { turnId: "t4", item: { id: "a4", type: "agentMessage", phase: "final_answer", text: "Live answer" } } } });
  emit({ type: "thread_event", threadId: "source", event: { method: "turn/completed", params: { turn: { id: "t4", status: "completed" } } } });
  await expect(branchAt(page, "a4")).toBeEnabled();
  await branchAt(page, "a4").click();
  await dialog(page).getByRole("button", { name: "创建并打开分支", exact: true }).click();
  await expect.poll(() => branches).toEqual([{ lastTurnId: "t4" }]); expect(errors).toEqual([]);
});

test("mobile light-theme branch dialog fits and its message controls are reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("codex-console-theme", "light"));
  const { errors } = await open(page);
  await branchAt(page, "a2").click();
  await expect(dialog(page)).toBeVisible();
  const box = (await page.locator(".branch-dialog").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(845);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? "/tmp", "mobile-branch.png") });
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); expect(errors).toEqual([]);
});
