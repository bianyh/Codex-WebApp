import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const origin = "http://10.0.0.123:8787";
const thread = { id: "code-copy-thread", title: "Code copy", cwd: "/tmp", status: "completed", canRetry: true };
const markdown = [
  "Fenced: `inline code`",
  "",
  "```ts",
  "const answer = 42;",
  "  return answer;",
  "```",
  "",
  "Indented text:",
  "",
  "    first line",
  "      second line",
].join("\n");
const snapshot = {
  thread,
  items: [
    { id: "copy-user", kind: "user", text: "Show code" },
    { id: "copy-agent", kind: "agent", text: markdown, status: "final_answer" },
  ],
  pendingRequests: [],
};

async function openConsole(page: Page, { clipboard = "api", light = false } = {}) {
  if (light) await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(({ mode, lightMode }) => {
    localStorage.setItem("codex-console-theme", lightMode ? "light" : "dark");
    let copied = "";
    Object.defineProperty(window, "__getCopiedText", {
      configurable: true,
      value: () => copied,
    });
    if (mode === "api") {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value: string) => { copied = value; } },
      });
      return;
    }
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = (command: string) => {
      if (command !== "copy") return false;
      copied = document.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value ?? "";
      return true;
    };
  }, { mode: clipboard, lightMode: light });
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/api/")) {
      let data: unknown = [];
      if (pathname === "/api/auth/me") data = { authenticated: true };
      else if (pathname === "/api/threads") data = [thread];
      else if (pathname.endsWith("/goal")) data = { goal: null, supported: true, canControl: true };
      else if (pathname.startsWith("/api/threads/")) data = snapshot;
      else if (pathname === "/api/models") data = [];
      else if (pathname === "/api/fs/list") data = { path: "/tmp", root: "/tmp", parent: null, entries: [] };
      await route.fulfill({ json: { ok: true, data } });
      return;
    }
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    const buildDir = process.env.CODEX_CONSOLE_BUILD_DIR ?? process.cwd();
    const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".html") ? "text/html" : "application/octet-stream";
    try { await route.fulfill({ body: await readFile(path.join(buildDir, "dist/web", filename)), contentType }); }
    catch { await route.fulfill({ status: 404 }); }
  });
  await page.routeWebSocket(`${origin.replace("http", "ws")}/ws`, (socket) => {
    socket.onMessage((raw) => {
      const action = JSON.parse(String(raw));
      if (action.type === "subscribe_thread") socket.send(JSON.stringify({ type: "thread_snapshot", snapshot }));
    });
  });
  await page.goto(origin);
  await expect(page.locator("html")).toHaveAttribute("data-theme", light ? "light" : "dark");
  await expect(page.locator(".prose-code-block")).toHaveCount(2);
}

test("Markdown code and preformatted blocks provide copy buttons", async ({ page }) => {
  await openConsole(page);
  await expect(page.getByText("inline code", { exact: true })).toBeVisible();
  await expect(page.locator(".prose-code-block").getByRole("button", { name: "复制代码内容", exact: true })).toHaveCount(2);

  await page.locator(".prose-code-block").first().getByRole("button", { name: "复制代码内容", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe("const answer = 42;\n  return answer;");
  await expect(page.getByRole("button", { name: "已复制代码内容", exact: true })).toBeVisible();

  await page.locator(".prose-code-block").nth(1).getByRole("button", { name: "复制代码内容", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe("first line\n  second line");
  await expect(page.locator(".prose-code-block").nth(1).getByRole("button", { name: "已复制代码内容", exact: true })).toBeVisible();
});

test("mobile light theme copies through the HTTP clipboard fallback without overflow", async ({ page }) => {
  await openConsole(page, { clipboard: "fallback", light: true });
  const button = page.locator(".prose-code-block").first().getByRole("button", { name: "复制代码内容", exact: true });
  await expect(button).toBeVisible();
  await expect.poll(() => button.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(40);
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe("const answer = 42;\n  return answer;");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
