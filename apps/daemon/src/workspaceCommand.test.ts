import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseCommandLine, runWorkspaceCommand } from "./workspaceCommand.js";

describe("workspace commands", () => {
  it("parses quoted arguments without invoking a shell", () => {
    expect(parseCommandLine("ls -la 'folder name'")).toEqual(["ls", "-la", "folder name"]);
    expect(() => parseCommandLine("ls && pwd")).toThrow("不支持管道");
    expect(() => parseCommandLine("ls 'unfinished")).toThrow("没有闭合");
  });

  it("runs allowed commands in the selected workspace directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-console-command-"));
    const cwd = path.join(root, "project");
    await mkdir(cwd);
    const result = await runWorkspaceCommand({ command: "pwd", cwd, workspaceRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(cwd);
  });

  it("rejects shell commands, mutating Git commands, and paths outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-console-command-"));
    await expect(runWorkspaceCommand({ command: "sh -c whoami", cwd: root, workspaceRoot: root })).rejects.toThrow("仅支持");
    await expect(runWorkspaceCommand({ command: "git branch -D main", cwd: root, workspaceRoot: root })).rejects.toThrow("仅支持查看");
    await expect(runWorkspaceCommand({ command: "git branch new-branch", cwd: root, workspaceRoot: root })).rejects.toThrow("仅支持查看");
    await expect(runWorkspaceCommand({ command: "ls /", cwd: root, workspaceRoot: root })).rejects.toThrow("必须位于工作区内");
  });
});
