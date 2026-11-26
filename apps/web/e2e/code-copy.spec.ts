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
async function openConsole(page: Page, { clipboard = "api", light = false, message = markdown } = {}) {
  const snapshot = {
    thread,
    items: [
      { id: "copy-user", kind: "user", text: "Show code" },
      { id: "copy-agent", kind: "agent", text: message, status: "final_answer" },
    ],
    pendingRequests: [],
  };
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

test("bare Mermaid flowcharts render and retain their Chinese source on mobile", async ({ page }) => {
  const source = [
    "flowchart LR",
    '    A["当前目标与待执行计划"] --> B["定位关键依赖和可替代能力"]',
    '    B --> C["按预期决策收益选择查询"]',
    '    C --> D["观测或反馈"]',
    '    D --> E["提交带版本和来源的图谱更新"]',
    '    E --> F["校验依赖并修复受影响步骤"]',
    '    F --> G["执行下一步"]',
    "    G --> D",
  ].join("\n");
  await openConsole(page, { clipboard: "fallback", light: true, message: `流程如下：${source}\n总结：根据观测修复计划。` });
  const block = page.locator(".mermaid-block");
  const image = block.getByRole("img", { name: "Mermaid 图表" });
  await expect(image).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  expect(await image.evaluate(async (element: HTMLImageElement) => {
    const svg = await (await fetch(element.src)).text();
    return new DOMParser().parseFromString(svg, "image/svg+xml").documentElement.textContent;
  })).toContain("校验依赖并修复受影响步骤");
  await expect(page.getByText("总结：根据观测修复计划。")).toBeVisible();

  const preview = block.getByRole("region", { name: "Mermaid 图表预览" });
  expect(await preview.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await expect(block.locator("pre")).toBeHidden();
  await block.getByRole("button", { name: "查看源码" }).click();
  await expect(block.locator("pre")).toBeVisible();
  expect(await block.locator("pre").textContent()).toBe(source);
  await block.getByRole("button", { name: "复制 Mermaid 源码" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe(source);
  await block.getByRole("button", { name: "收起源码" }).click();
  await expect(block.locator("pre")).toBeHidden();
  await expect(image).toBeVisible();
});

test("fenced Mermaid supports other diagram types and exposes invalid source", async ({ page }) => {
  const source = "sequenceDiagram\n  Alice->>Bob: Hello";
  const invalidSource = "flowchart LR\n  A --> [";
  await openConsole(page, { message: [
    "```mermaid", source, "```", "",
    "~~~mermaid", invalidSource, "~~~",
  ].join("\n") });

  const diagrams = page.locator(".mermaid-block");
  await expect(diagrams).toHaveCount(2);
  const image = diagrams.first().getByRole("img", { name: "Mermaid 图表" });
  await expect(image).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await expect(diagrams.last().getByRole("status")).toHaveText("无法渲染此 Mermaid 图表");
  await expect(diagrams.last().locator("pre")).toBeVisible();
  await diagrams.last().getByRole("button", { name: "复制 Mermaid 源码" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe(invalidSource);
});
