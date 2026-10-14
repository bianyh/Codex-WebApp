import { spawn } from "node:child_process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sourceFingerprint, artifactFingerprint } from "./build-manifest.mjs";

const output = process.env.CODEX_CONSOLE_BUILD_DIR;
const sourceBefore = output ? await sourceFingerprint(process.cwd()) : undefined;
for (const [script, relativePath] of [["build:web", "dist/web"], ["build:daemon", "apps/daemon/dist"]]) {
  const args = ["run", script];
  if (output) args.push("--", "--outDir", path.resolve(output, relativePath));
  await new Promise((resolve, reject) => {
    const child = spawn("npm", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
  });
}
if (output) {
  const sourceAfter = await sourceFingerprint(process.cwd());
  if (sourceAfter !== sourceBefore) throw new Error("Source changed during build; rerun the staged build");
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "--short=12", "HEAD"]);
  await writeFile(path.join(output, "build-manifest.json"), JSON.stringify({ baseRevision: stdout.trim(), sourceFingerprint: sourceAfter, artifactFingerprint: await artifactFingerprint(output), builtAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
}
