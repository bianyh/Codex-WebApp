import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("deferred deployment", () => {
  it("creates a release without a preexisting copy target or overwriting another release", async () => {
    const { prepareRelease } = await import("./deploy-when-idle.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "codex-release-test-"));
    try {
      const build = path.join(root, "build");
      const repo = path.join(root, "repo");
      const release = path.join(root, "releases/version");
      await mkdir(build);
      await mkdir(path.join(repo, "node_modules"), { recursive: true });
      await writeFile(path.join(build, "artifact"), "verified build");
      await writeFile(path.join(repo, "package.json"), '{"type":"module"}');
      await prepareRelease(build, release, repo);
      expect(await readFile(path.join(release, "artifact"), "utf8")).toBe("verified build");
      expect(await realpath(path.join(release, "node_modules"))).toBe(path.join(repo, "node_modules"));
      await expect(prepareRelease(build, release, repo)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("requires ready, known-idle state and refuses pending work", async () => {
    const { isIdleHealth } = await import("./deploy-when-idle.mjs");
    const ready = { ok: true, data: { ok: true, appServer: "ready", activeThreads: 0 } };
    expect(isIdleHealth(ready)).toBe(true);
    expect(isIdleHealth(undefined)).toBe(false);
    expect(isIdleHealth({ ...ready, data: { ...ready.data, activeThreads: 1 } })).toBe(false);
    for (const key of ["activeCommands", "queuedTurns", "pendingRequests", "turnOperations"]) {
      expect(isIdleHealth({ ...ready, data: { ...ready.data, [key]: 1 } })).toBe(false);
    }
  });
  it("resets the idle window on busy state and failed health checks", async () => {
    const { waitForIdle } = await import("./deploy-when-idle.mjs");
    const idle = { ok: true, data: { ok: true, appServer: "ready", activeThreads: 0 } };
    const states = [idle, { ok: true, data: { ...idle.data, activeThreads: 1 } }, idle, undefined, idle, idle, idle];
    let calls = 0;
    await waitForIdle({ requiredSamples: 3, readHealth: async () => states[calls++], sleep: async () => {} });
    expect(calls).toBe(7);
  });
});
