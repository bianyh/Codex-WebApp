import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveServerDirectory, resolveServerPath } from "./serverDirectory.js";

describe("server directories", () => {
  it("accepts an absolute directory outside the configured workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-console-directory-"));
    await expect(resolveServerDirectory(directory, "/unused/base")).resolves.toBe(directory);
  });

  it("resolves relative directories from the configured Codex cwd", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "codex-console-directory-"));
    const child = await mkdtemp(path.join(parent, "child-"));
    await expect(resolveServerDirectory(path.basename(child), parent)).resolves.toBe(child);
  });

  it("rejects files and missing paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-console-directory-"));
    const filename = path.join(directory, "file.txt");
    await writeFile(filename, "content");
    await expect(resolveServerDirectory(filename, directory)).rejects.toThrow("路径不是文件夹");
    await expect(resolveServerDirectory("missing", directory)).rejects.toThrow();
  });

  it("resolves files anywhere the daemon user can access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-console-path-"));
    const filename = path.join(directory, "file.txt");
    await writeFile(filename, "content");
    await expect(resolveServerPath(filename, "/unused/base")).resolves.toBe(filename);
    await expect(resolveServerPath("file.txt", directory)).resolves.toBe(filename);
  });
});
