import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const thread = (id: string) => ({ id, title: `Thread ${id}`, cwd: "/tmp", status: "completed", canRetry: true });
const snapshot = (id: string) => ({ thread: thread(id), items: [{ id: `${id}-user`, kind: "user", text: `Prompt ${id}` }, { id: `${id}-final`, kind: "agent", status: "final_answer", text: `Latest ${id}` }], pendingRequests: [] });

async function setup(page: Page, { saved, missing = false, fail = false, holdList = false }: { saved?: string; missing?: boolean; fail?: boolean; holdList?: boolean } = {}) {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  if (saved) await page.addInitScript((id) => localStorage.setItem("codex-console-selected-thread", id), saved);
  let releaseList!: () => void;
  const listReady = holdList ? new Promise<void>((resolve) => { releaseList = resolve; }) : Promise.resolve();
  let listed = [thread("recent"), thread("saved")];
  const reads: string[] = []; const listQueries: string[] = [];
  let emit = (_event: unknown) => {};
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (url.pathname === "/api/auth/me") data = { authenticated: true };
      else if (url.pathname === "/api/threads") { listQueries.push(url.search); await listReady; data = { threads: listed, nextCursor: null }; }
      else if (url.pathname === "/api/models") data = [];
      else if (url.pathname === "/api/threads/refresh") { emit({ type: "thread_index_updated", archived: request.postDataJSON().archived }); data = { scheduled: true }; }
      else if (url.pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (url.pathname.startsWith("/api/threads/")) {
        const id = url.pathname.split("/").at(-1)!; reads.push(id);
        if (id === saved && (missing || fail)) { await route.fulfill({ status: missing ? 404 : 503, json: { ok: false, error: { message: missing ? "Thread no longer exists" : "Temporary failure" } } }); return; }
        data = snapshot(id);
      } else if (url.pathname === "/api/fs/list") data = { path: "/tmp", root: "/", parent: "/", entries: [] };
      await route.fulfill({ json: { ok: true, data } }); return;
    }
    const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    try { await route.fulfill({ body: await readFile(path.join(process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd(), "dist/web", filename)), contentType: filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    emit = (event) => socket.send(JSON.stringify(event));
    socket.onMessage((raw) => { const action = JSON.parse(String(raw)); if (action.type === "subscribe_thread") emit({ type: "thread_snapshot", snapshot: snapshot(action.threadId) }); });
  });
  await page.goto(origin);
  return { errors, reads, listQueries, releaseList, emit: (value: unknown) => emit(value), setList: (ids: string[]) => { listed = ids.map(thread); } };
}

test("restores the last conversation while the sidebar list is still pending", async ({ page }) => {
  const { errors, releaseList, reads } = await setup(page, { saved: "saved", holdList: true });
  await expect(page.locator(".final-agent-message")).toHaveText(/Latest saved/);
  expect(reads).toContain("saved");
  releaseList(); await expect(page.locator(".thread-row")).toHaveCount(2);
  await expect(page.locator(".topbar-title")).toContainText("Thread saved");
  await expect(page.locator(".thread-id-row code")).toHaveText("saved");
  await page.getByRole("button", { name: /Thread recent/ }).click();
  await expect(page.locator(".thread-id-row code")).toHaveText("recent");
  await expect(page.locator(".final-agent-message")).toContainText("Latest recent");
  expect(await page.evaluate(() => localStorage.getItem("codex-console-selected-thread"))).toBe("recent");
  expect(errors).toEqual([]);
});

test("a missing saved conversation falls back without waiting for a retry loop", async ({ page }) => {
  const { errors, reads } = await setup(page, { saved: "saved", missing: true });
  await expect(page.locator(".final-agent-message")).toContainText("Latest recent");
  expect(reads.filter((id) => id === "saved").length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("codex-console-selected-thread"))).toBe("recent");
  expect(errors).toEqual([]);
});

test("temporary history errors do not silently change the saved conversation", async ({ page }) => {
  const { reads, errors } = await setup(page, { saved: "saved", fail: true });
  await expect(page.locator(".toast-error")).toContainText("Temporary failure");
  expect(await page.evaluate(() => localStorage.getItem("codex-console-selected-thread"))).toBe("saved");
  expect(reads).toEqual(["saved"]); expect(errors).toEqual([]);
});

test("background index updates and manual refresh preserve the current conversation and draft", async ({ page }) => {
  const { errors, emit, setList } = await setup(page);
  await expect(page.locator(".final-agent-message")).toContainText("Latest recent");
  await page.locator(".composer textarea").fill("Keep this draft");
  setList(["new", "recent", "saved"]); emit({ type: "thread_index_updated", archived: false });
  await expect(page.locator(".thread-row")).toHaveCount(3);
  await expect(page.locator(".final-agent-message")).toContainText("Latest recent");
  await expect(page.locator(".composer textarea")).toHaveValue("Keep this draft");
  setList(["newer", "new", "recent", "saved"]);
  await page.getByRole("button", { name: "刷新线程索引", exact: true }).click();
  await expect(page.locator(".thread-row")).toHaveCount(4);
  await expect(page.locator(".composer textarea")).toHaveValue("Keep this draft");
  expect(errors).toEqual([]);
});
