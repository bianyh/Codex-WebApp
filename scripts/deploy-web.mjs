import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBuildManifest } from "./build-manifest.mjs";

const execute = promisify(execFile);
const digest = (content) => createHash("sha256").update(content).digest("hex");
async function files(root, relative = "") {
  const result = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, filename));
    else if (entry.isFile()) result.push(filename);
    else throw new Error("Release trees cannot contain symlinks or special files");
  }
  return result;
}

export async function identicalDaemon(buildDir, release) {
  const source = path.join(buildDir, "apps/daemon/dist");
  const target = path.join(release, "apps/daemon/dist");
  const names = await files(source);
  if (JSON.stringify(names) !== JSON.stringify(await files(target))) return false;
  for (const filename of names) if (digest(await readFile(path.join(source, filename))) !== digest(await readFile(path.join(target, filename)))) return false;
  return true;
}

export async function publishWeb(buildDir, release) {
  if (!await identicalDaemon(buildDir, release)) throw new Error("Daemon differs; use idle-aware full deployment");
  const source = await realpath(path.join(buildDir, "dist/web"));
  const target = await realpath(path.join(release, "dist/web"));
  if (source === target) throw new Error("Staged and running web directories must differ");
  const names = await files(source);
  await files(target); // Validate the existing target before adding any assets.
  const additions = [];
  // Never overwrite hash-addressed assets or change a service worker/config during hot publication.
  for (const filename of names.filter((name) => name !== "index.html")) {
    try {
      if (digest(await readFile(path.join(source, filename))) !== digest(await readFile(path.join(target, filename)))) throw new Error(`Existing asset differs: ${filename}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!filename.startsWith(`assets${path.sep}`)) throw new Error(`Non-asset addition requires full deployment: ${filename}`);
      additions.push(filename);
    }
  }
  const original = await readFile(path.join(target, "index.html"));
  for (const filename of additions) {
    await mkdir(path.dirname(path.join(target, filename)), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, filename), path.join(target, filename), constants.COPYFILE_EXCL);
  }
  const installIndex = async (content) => {
    const temporary = path.join(target, `.index-${randomUUID()}.tmp`);
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path.join(target, "index.html"));
  };
  const updated = await readFile(path.join(source, "index.html"));
  await installIndex(updated);
  return { original, updated, additions, restore: () => installIndex(original) };
}

async function deploy() {
  const repo = await realpath(process.cwd());
  if (!process.env.CODEX_CONSOLE_BUILD_DIR) throw new Error("Set a validated staged CODEX_CONSOLE_BUILD_DIR");
  const build = await realpath(process.env.CODEX_CONSOLE_BUILD_DIR);
  if (build === repo || build.startsWith(`${repo}${path.sep}`)) throw new Error("Build must be staged outside checkout");
  const snapshotRevision = await validateBuildManifest(build, repo);
  const { stdout: dirty } = await execute("git", ["status", "--porcelain"]);
  const revision = dirty ? snapshotRevision : (await execute("git", ["rev-parse", "--short=12", "HEAD"])).stdout.trim();
  const environment = await readFile(path.join(homedir(), ".config/codex-console/environment"), "utf8");
  const port = environment.match(/^CODEX_CONSOLE_PORT=(\d+)$/m)?.[1] ?? "8787";
  const base = `http://127.0.0.1:${port}`;
  const health = async () => (await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(5000) })).json();
  const before = await health();
  if (!before.ok || before.data?.appServer !== "ready") throw new Error("Current daemon is not healthy");
  const { stdout } = await execute("systemctl", ["--user", "show", "codex-console.service", "--property=MainPID", "--value"]);
  const pid = Number(stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Service is not running");
  const release = await realpath(`/proc/${pid}/cwd`);
  const deployments = await realpath(path.join(homedir(), ".local/state/codex-console/deployment"));
  if (!release.startsWith(`${deployments}${path.sep}releases${path.sep}`)) throw new Error("Running service is not a managed release");
  const prefix = path.join(deployments, "backups", `web-${Date.now()}`);
  await mkdir(path.dirname(prefix), { recursive: true, mode: 0o700 });
  const original = await readFile(path.join(release, "dist/web/index.html"));
  await writeFile(`${prefix}.html`, original, { mode: 0o600 });
  const published = await publishWeb(build, release);
  try {
    const response = await fetch(base, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok || digest(await response.arrayBuffer().then((value) => Buffer.from(value))) !== digest(published.updated)) throw new Error("Live HTML does not match staged HTML");
    const html = published.updated.toString();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map((match) => match[1]);
    if (!assets.length) throw new Error("Missing JS/CSS entry points");
    for (const asset of assets) {
      const served = await fetch(`${base}${asset}`, { signal: AbortSignal.timeout(5000) });
      if (!served.ok || digest(Buffer.from(await served.arrayBuffer())) !== digest(await readFile(path.join(build, "dist/web", asset.slice(1))))) throw new Error("Live asset verification failed");
    }
    const after = await health();
    const currentPid = Number((await execute("systemctl", ["--user", "show", "codex-console.service", "--property=MainPID", "--value"])).stdout.trim());
    if (pid !== currentPid || !after.ok || after.data?.appServer !== "ready" || after.data.buildRevision !== before.data.buildRevision) throw new Error("Service changed during publication");
    const result = { status: "web_deployed", revision, daemonRevision: after.data.buildRevision, release, completedAt: new Date().toISOString(), addedAssets: published.additions.length };
    await writeFile(path.join(deployments, "web-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(`Frontend verified: ${revision}; daemon PID ${pid} unchanged; previous assets retained`);
  } catch (error) { await published.restore(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) deploy().catch((error) => { console.error(error.message); process.exitCode = 1; });
