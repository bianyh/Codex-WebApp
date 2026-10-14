import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

describe("deferred deployment", () => {
  it("validates uncommitted source snapshots and detects artifact or source drift", async () => {
    const { artifactFingerprint, sourceFingerprint, validateBuildManifest } = await import("./build-manifest.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "codex-manifest-test-"));
    try {
      await promisify(execFile)("git", ["init", "-q", root]);
      await writeFile(path.join(root, "source.ts"), "original");
      const build = path.join(root, "build");
      await writeFile(path.join(root, ".gitignore"), "build/\n");
      for (const directory of ["dist/web", "apps/daemon/dist"]) { await mkdir(path.join(build, directory), { recursive: true }); await writeFile(path.join(build, directory, "artifact"), "compiled"); }
      const manifest = { baseRevision: "0123456789ab", sourceFingerprint: await sourceFingerprint(root), artifactFingerprint: await artifactFingerprint(build) };
      await writeFile(path.join(build, "build-manifest.json"), JSON.stringify(manifest));
      expect(await validateBuildManifest(build, root)).toBe(`0123456789ab-snapshot-${manifest.sourceFingerprint.slice(0, 12)}`);
      await writeFile(path.join(build, "dist/web/artifact"), "modified");
      await expect(validateBuildManifest(build, root)).rejects.toThrow("artifacts changed");
      await writeFile(path.join(build, "dist/web/artifact"), "compiled");
      await writeFile(path.join(root, "source.ts"), "changed");
      await expect(validateBuildManifest(build, root)).rejects.toThrow("Source changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
