import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Goal, GoalState } from "../src/types";

const origin = "http://10.0.0.123:8787";
const thread = { id: "goal-thread", title: "Goal regression", cwd: "/tmp", status: "completed", canRetry: true };
const snapshot = { thread, items: [], pendingRequests: [] };
const initialGoal: Goal = { threadId: thread.id, objective: "Implement the goal panel", status: "active", tokenBudget: 2000, tokensUsed: 100, timeUsedSeconds: 75 };

async function openGoal(page: Page, state: GoalState) {
  const errors: string[] = [];
  const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];
  let current = structuredClone(state);
  let rejectNext = false;
  let send = (_event: unknown) => {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname.endsWith("/goal")) {
      const method = route.request().method();
      if (method === "PATCH") {
        const body = route.request().postDataJSON();
        mutations.push({ method, body });
        if (rejectNext) { rejectNext = false; await route.fulfill({ status: 409, json: { ok: false, error: { message: "线程被其他 Codex 占用" } } }); return; }
        current = { ...current, goal: { ...(current.goal ?? { ...initialGoal, objective: "", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 }), ...body } };
      } else if (method === "DELETE") { mutations.push({ method, body: {} }); current = { ...current, goal: null }; }
      await route.fulfill({ json: { ok: true, data: current } });
      return;
    }
    if (pathname.startsWith("/api/")) {
      const data = pathname === "/api/auth/me" ? { authenticated: true } : pathname === "/api/threads" ? [thread] : pathname.startsWith("/api/threads/") ? snapshot : pathname === "/api/fs/list" ? { path: "/tmp", root: "/tmp", parent: null, entries: [] } : [];
      await route.fulfill({ json: { ok: true, data } });
      return;
    }
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
    try { await route.fulfill({ body: await readFile(path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd(), "dist/web", filename)), contentType }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    send = (event) => socket.send(JSON.stringify(event));
    socket.onMessage((raw) => { if (JSON.parse(String(raw)).type === "subscribe_thread") send({ type: "thread_snapshot", snapshot }); });
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "打开目标控制", exact: true }).click();
  const panel = page.locator(".goal-panel:visible");
  await expect(panel).toBeVisible();
  return { panel, errors, mutations, emit: (event: unknown) => send(event), rejectNextUpdate: () => { rejectNext = true; } };
}

test("goal controls show content, pause/resume, edit budget and confirm deletion", async ({ page }) => {
  const { panel, errors, mutations } = await openGoal(page, { goal: initialGoal, supported: true, canControl: true });
  await expect(page.locator(".goal-summary")).toContainText(initialGoal.objective);
  await expect(panel.locator(".goal-objective")).toHaveText(initialGoal.objective);
  await expect(panel.locator(".goal-metrics")).toContainText("1 分 15 秒");
  await panel.getByRole("button", { name: "暂停目标", exact: true }).click();
  await expect(panel.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await panel.getByRole("button", { name: "编辑目标", exact: true }).click();
  await panel.getByRole("textbox", { name: "目标内容", exact: true }).fill("Revised objective");
  await panel.getByRole("textbox", { name: "目标 Token 预算", exact: true }).fill("5000");
  await panel.getByRole("button", { name: "保存目标", exact: true }).click();
  await expect(panel.locator(".goal-objective")).toHaveText("Revised objective");
  await expect(panel.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await panel.getByRole("switch").click();
  await expect(panel.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("button", { name: "删除目标", exact: true }).click();
  expect(mutations.filter((value) => value.method === "DELETE")).toHaveLength(0);
  await panel.getByRole("button", { name: "确认删除目标", exact: true }).click();
  await expect(panel.getByRole("button", { name: "设置目标", exact: true })).toBeVisible();
  await expect(page.locator(".goal-summary")).toHaveCount(0);
  expect(mutations.map((value) => value.method)).toEqual(["PATCH", "PATCH", "PATCH", "DELETE"]);
  expect(mutations[1].body).toEqual({ objective: "Revised objective", tokenBudget: 5000 });
  expect(errors).toEqual([]);
});

test("mobile goal creation validates content and budget without overflowing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { panel, errors, mutations } = await openGoal(page, { goal: null, supported: true, canControl: true });
  await panel.getByRole("switch").click();
  await panel.getByRole("button", { name: "创建并启用", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("目标内容不能为空");
  await panel.getByRole("textbox", { name: "目标内容", exact: true }).fill("Mobile target");
  await panel.getByRole("textbox", { name: "目标 Token 预算", exact: true }).fill("-1");
  await panel.getByRole("button", { name: "创建并启用", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("正整数");
  expect(mutations).toHaveLength(0);
  await panel.getByRole("textbox", { name: "目标 Token 预算", exact: true }).fill("");
  await panel.getByRole("button", { name: "创建并启用", exact: true }).click();
  await expect(panel.locator(".goal-objective")).toHaveText("Mobile target");
  expect(mutations[0].body).toEqual({ objective: "Mobile target", tokenBudget: null, status: "active" });
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test("external goals are read-only and incoming lifecycle events update their display", async ({ page }) => {
  const { panel, emit, mutations, errors } = await openGoal(page, { goal: initialGoal, supported: true, canControl: false, controlReason: "由外部 Codex 窗口持有" });
  await expect(panel.getByRole("switch")).toBeDisabled();
  await expect(panel.getByRole("button", { name: "编辑目标", exact: true })).toBeDisabled();
  await expect(panel).toContainText("由外部 Codex 窗口持有");
  emit({ type: "thread_event", threadId: thread.id, event: { method: "thread/goal/updated", params: { goal: { ...initialGoal, status: "blocked", objective: "Updated externally" } } } });
  await expect(panel.locator(".goal-objective")).toHaveText("Updated externally");
  await expect(page.locator(".goal-summary")).toContainText("受阻");
  await expect(panel.getByRole("switch")).toBeDisabled();
  expect(mutations).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("unsupported goals display a disabled explanation instead of a broken switch", async ({ page }) => {
  const { panel } = await openGoal(page, { goal: null, supported: false, canControl: false, controlReason: "当前 Codex 不支持目标模式" });
  await expect(panel.getByRole("switch")).toBeDisabled();
  await expect(panel).toContainText("不支持目标模式");
});

test("a failed goal edit preserves the draft and leaves the conversation visible", async ({ page }) => {
  const { panel, errors, rejectNextUpdate } = await openGoal(page, { goal: { ...initialGoal, status: "paused" }, supported: true, canControl: true });
  await panel.getByRole("button", { name: "编辑目标", exact: true }).click();
  await panel.getByRole("textbox", { name: "目标内容", exact: true }).fill("Preserved draft");
  rejectNextUpdate();
  await panel.getByRole("button", { name: "保存目标", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("线程被其他 Codex 占用");
  await expect(panel.getByRole("textbox", { name: "目标内容", exact: true })).toHaveValue("Preserved draft");
  await expect(panel.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(errors).toEqual([]);
});
