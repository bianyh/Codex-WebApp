import { spawn } from "node:child_process";
import path from "node:path";

const output = process.env.CODEX_CONSOLE_BUILD_DIR;
for (const [script, relativePath] of [["build:web", "dist/web"], ["build:daemon", "apps/daemon/dist"]]) {
  const args = ["run", script];
  if (output) args.push("--", "--outDir", path.resolve(output, relativePath));
  await new Promise((resolve, reject) => {
    const child = spawn("npm", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
  });
}
