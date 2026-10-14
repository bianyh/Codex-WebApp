import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);
export async function sourceFingerprint(repo) {
  const { stdout } = await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo });
  const hash = createHash("sha256");
  for (const filename of [...new Set(stdout.split("\0").filter(Boolean))].sort()) {
    if (filename.startsWith("../") || path.isAbsolute(filename)) throw new Error("Repository source paths must remain inside checkout");
    hash.update(filename); hash.update("\0");
    try { hash.update(await readFile(path.join(repo, filename))); } catch (error) { if (error.code !== "ENOENT") throw error; hash.update("<deleted>"); }
    hash.update("\0");
  }
  return hash.digest("hex");
}
export async function artifactFingerprint(buildDir) {
  const hash = createHash("sha256");
  const visit = async (relative) => {
    for (const entry of (await readdir(path.join(buildDir, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) { hash.update(filename); hash.update("\0"); hash.update(await readFile(path.join(buildDir, filename))); hash.update("\0"); }
      else throw new Error("Staged artifacts cannot contain symlinks or special files");
    }
  };
  for (const directory of ["apps/daemon/dist", "dist/web"]) await visit(directory);
  return hash.digest("hex");
}
export async function validateBuildManifest(buildDir, repo) {
  const manifest = JSON.parse(await readFile(path.join(buildDir, "build-manifest.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint ?? "") || !/^[a-f0-9]{64}$/.test(manifest.artifactFingerprint ?? "") || !/^[a-f0-9]{12}$/.test(manifest.baseRevision ?? "")) throw new Error("Invalid staged build provenance");
  if (manifest.sourceFingerprint !== await sourceFingerprint(repo)) throw new Error("Source changed after build; rebuild and validate before deploying");
  if (manifest.artifactFingerprint !== await artifactFingerprint(buildDir)) throw new Error("Staged artifacts changed after build");
  return `${manifest.baseRevision}-snapshot-${manifest.sourceFingerprint.slice(0, 12)}`;
}
