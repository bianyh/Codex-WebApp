import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isIdleHealth(response) {
  const state = response?.data;
  return response?.ok === true && state?.ok === true && state.appServer === "ready" && state.activeThreads === 0 &&
    [state.activeCommands, state.queuedTurns, state.pendingRequests, state.turnOperations].every((count) => count === undefined || count === 0);
}

export async function waitForIdle({ readHealth, sleep, requiredSamples = 6, onState = () => {} }) {
  let idleSamples = 0;
  while (idleSamples < requiredSamples) {
    let response;
    try { response = await readHealth(); } catch { response = undefined; }
    idleSamples = isIdleHealth(response) ? idleSamples + 1 : 0;
    onState(response?.data, idleSamples);
    if (idleSamples < requiredSamples) await sleep();
  }
}

export async function prepareRelease(buildDir, release, repo) {
  await mkdir(path.dirname(release), { recursive: true, mode: 0o700 });
  await cp(buildDir, release, { recursive: true, errorOnExist: true, force: false });
  await chmod(release, 0o700);
  await cp(path.join(repo, "package.json"), path.join(release, "package.json"));
  await symlink(path.join(repo, "node_modules"), path.join(release, "node_modules"));
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function deploy() {
  const repo = await realpath(process.cwd());
  if (!process.env.CODEX_CONSOLE_BUILD_DIR) throw new Error("Set CODEX_CONSOLE_BUILD_DIR to a validated staged build outside the checkout");
  const buildDir = await realpath(process.env.CODEX_CONSOLE_BUILD_DIR);
  if (buildDir === repo || buildDir.startsWith(`${repo}${path.sep}`)) throw new Error("Build directory must be outside the checkout");
  for (const filename of ["apps/daemon/dist/index.js", "dist/web/index.html"]) {
    if (!(await stat(path.join(buildDir, filename))).isFile()) throw new Error(`Missing staged artifact: ${filename}`);
  }
  const service = "codex-console.service";
  const stateDir = path.join(homedir(), ".local/state/codex-console/deployment");
  const configDir = path.join(homedir(), ".config/codex-console");
  const unitPath = path.join(homedir(), ".config/systemd/user", service);
  const environmentPath = path.join(configDir, "environment");
  if (await run("git", ["status", "--porcelain"])) throw new Error("Commit or save repository changes before scheduling deployment");
  const revision = await run("git", ["rev-parse", "--short=12", "HEAD"]);
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const release = path.join(stateDir, "releases", `${suffix}-${revision}`);
  await prepareRelease(buildDir, release, repo);
  const unitTemplate = await readFile(path.join(repo, "deploy/codex-console.service"), "utf8");
  const environment = await readFile(environmentPath, "utf8");
  const originalUnit = await readFile(unitPath, "utf8");
  const configuredPort = environment.match(/^CODEX_CONSOLE_PORT=(\d+)$/m)?.[1] ?? "8787";
  const healthUrl = `http://127.0.0.1:${configuredPort}/api/healthz`;
  const readHealth = async () => {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Health check failed");
    return response.json();
  };
  const readRoot = async () => (await fetch(`http://127.0.0.1:${configuredPort}/`, { signal: AbortSignal.timeout(5000) })).ok;
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 5000));
  const current = path.join(stateDir, "current");
  let previous;
  try { previous = await realpath(current); } catch {}
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
  let lastState;
  log(`Prepared release ${revision}; waiting for six consecutive idle health checks`);
  do {
    await waitForIdle({ readHealth, sleep, onState: (state, samples) => {
      const key = JSON.stringify([state?.activeThreads, samples > 0]);
      if (key !== lastState) { log(`Activity: ${state?.activeThreads ?? "unknown"}; idle samples: ${samples}/6`); lastState = key; }
    } });
  } while (!isIdleHealth(await readHealth().catch(() => undefined)));
  if (!(await run("systemctl", ["--user", "is-active", service])).includes("active")) throw new Error("Service is not active; refusing automatic replacement");
  if (await readFile(environmentPath, "utf8") !== environment || await readFile(unitPath, "utf8") !== originalUnit) throw new Error("Service configuration changed while waiting; schedule a new deployment to preserve it");
  await mkdir(path.join(stateDir, "backups"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, "backups", `${suffix}.environment`), environment, { mode: 0o600 });
  await writeFile(path.join(stateDir, "backups", `${suffix}.service`), originalUnit, { mode: 0o600 });
  const escapedRepo = repo.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const unit = unitTemplate.replace("[Unit]\n", `[Unit]\nRequiresMountsFor="${escapedRepo}"\n`);
  const updatedEnvironment = environment.replace(/^CODEX_CONSOLE_(RELEASE_DIR|BUILD_REVISION)=.*\n?/gm, "").trimEnd() + `\nCODEX_CONSOLE_RELEASE_DIR=${current}\nCODEX_CONSOLE_BUILD_REVISION=${revision}\n`;
  const installFile = async (filename, content) => {
    const temporary = `${filename}.${suffix}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  };
  const switchRelease = async (target) => {
    const temporary = `${current}.${suffix}.tmp`;
    await symlink(target, temporary);
    await rename(temporary, current);
  };
  const verify = async (expectedRevision) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const health = await readHealth();
        if (health.ok && health.data?.appServer === "ready" && (!expectedRevision || health.data.buildRevision === expectedRevision)) {
          if (expectedRevision && process.env.CODEX_CONSOLE_EXPECTED_VERSION && health.data.codexVersion !== process.env.CODEX_CONSOLE_EXPECTED_VERSION) throw new Error("Unexpected Codex version");
          return health.data;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Deployment health verification timed out");
  };
  try {
    await switchRelease(release);
    await installFile(unitPath, unit);
    await installFile(environmentPath, updatedEnvironment);
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", service]);
    await run("systemctl", ["--user", "restart", service]);
    const health = await verify(revision);
    if (!(await readRoot())) throw new Error("Web page health check failed");
    await run("systemctl", ["--user", "is-enabled", service]);
    const result = { status: "deployed", revision, codexVersion: health.codexVersion, release, completedAt: new Date().toISOString() };
    await writeFile(path.join(stateDir, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    log(`Deployment verified: ${revision}; Codex ${health.codexVersion}`);
  } catch (error) {
    log("Deployment failed; restoring the previous service configuration");
    if (previous) await switchRelease(previous);
    await installFile(unitPath, originalUnit);
    await installFile(environmentPath, environment);
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "restart", service]);
    await verify();
    await writeFile(path.join(stateDir, "result.json"), JSON.stringify({ status: "rolled_back", revision, completedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
