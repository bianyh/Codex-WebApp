import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const output = path.resolve("generated/codex");
await mkdir(path.dirname(output), { recursive: true });
const staged = await mkdtemp(path.join(path.dirname(output), ".codex-schema-"));
const command = process.env.CODEX_COMMAND ?? "codex";

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex exited with ${code}`)));
  });
}

try {
  await run(["app-server", "generate-ts", "--out", staged]);
  await run(["app-server", "generate-json-schema", "--out", `${staged}/schema`]);
  const version = await new Promise((resolve, reject) => {
    const child = spawn(command, ["--version"]);
    let value = "";
    child.stdout.on("data", (chunk) => { value += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(value.trim()) : reject(new Error(`codex exited with ${code}`)));
  });
  await writeFile(`${staged}/metadata.json`, JSON.stringify({ codexVersion: version, generatedAt: new Date().toISOString() }, null, 2) + "\n");
  const previous = `${staged}-previous`;
  let replaced = false;
  try { await rename(output, previous); replaced = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await rename(staged, output); }
  catch (error) { if (replaced) await rename(previous, output); throw error; }
  if (replaced) await rm(previous, { recursive: true, force: true });
  console.log(`Generated Codex protocol artifacts for ${version}`);
} finally {
  await rm(staged, { recursive: true, force: true });
}
