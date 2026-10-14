import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { identicalDaemon, publishWeb } from "./deploy-web.mjs";

describe("frontend-only publication", () => {
  const fixture = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-web-deploy-test-"));
    const build = path.join(root, "staged"); const release = path.join(root, "running");
    for (const directory of [build, release]) {
      await mkdir(path.join(directory, "apps/daemon/dist"), { recursive: true });
      await mkdir(path.join(directory, "dist/web/assets"), { recursive: true });
      await writeFile(path.join(directory, "apps/daemon/dist/index.js"), "same daemon");
      await writeFile(path.join(directory, "dist/web/sw.js"), "same service worker");
    }
    await writeFile(path.join(release, "dist/web/index.html"), "old index");
    await writeFile(path.join(release, "dist/web/assets/old-hash.js"), "old app");
    await writeFile(path.join(build, "dist/web/index.html"), "new index");
    await writeFile(path.join(build, "dist/web/assets/new-hash.js"), "new app");
    return { root, build, release };
  };
  it("publishes new immutable assets, atomically switches HTML and preserves rollback", async () => {
    const { root, build, release } = await fixture();
    try {
      expect(await identicalDaemon(build, release)).toBe(true);
      const publication = await publishWeb(build, release);
      expect(await readFile(path.join(release, "dist/web/index.html"), "utf8")).toBe("new index");
      expect(await readFile(path.join(release, "dist/web/assets/old-hash.js"), "utf8")).toBe("old app");
      expect(await readFile(path.join(release, "dist/web/assets/new-hash.js"), "utf8")).toBe("new app");
      await publication.restore();
      expect(await readFile(path.join(release, "dist/web/index.html"), "utf8")).toBe("old index");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses daemon or service-worker changes before touching live HTML", async () => {
    const { root, build, release } = await fixture();
    try {
      await writeFile(path.join(build, "apps/daemon/dist/index.js"), "changed");
      await expect(publishWeb(build, release)).rejects.toThrow("Daemon differs");
      await writeFile(path.join(build, "apps/daemon/dist/index.js"), "same daemon");
      await writeFile(path.join(build, "dist/web/sw.js"), "changed");
      await expect(publishWeb(build, release)).rejects.toThrow("Existing asset differs");
      expect(await readFile(path.join(release, "dist/web/index.html"), "utf8")).toBe("old index");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
