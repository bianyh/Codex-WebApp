import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runWorkspaceCommand, validateShellCommand } from "./workspaceCommand.js";

describe("workspace shell commands", () => {
  it("validates empty, oversized, and null-containing commands", () => {
    expect(() => validateShellCommand("  ")).toThrow("命令不能为空");
    expect(() => validateShellCommand("x".repeat(16_001))).toThrow("16000");
    expect(() => validateShellCommand("printf '\0'")).toThrow("空字符");
  });

  it("runs arbitrary shell syntax in the selected directory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-console-shell-"));
    const result = await runWorkspaceCommand({
      command: "printf 'hello' | tr a-z A-Z > result.txt && cat result.txt",
      cwd,
      shell: "/bin/bash",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HELLO");
    expect(await readFile(path.join(cwd, "result.txt"), "utf8")).toBe("HELLO");
  });

  it("stops a running process group through AbortSignal", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-console-shell-"));
    const controller = new AbortController();
    const running = runWorkspaceCommand({ command: "sleep 30", cwd, shell: "/bin/bash", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(3000);
  });
});
