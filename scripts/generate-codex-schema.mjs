import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const output = "generated/codex";
await mkdir(output, { recursive: true });

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex exited with ${code}`)));
  });
}

await run(["app-server", "generate-ts", "--out", output]);
await run(["app-server", "generate-json-schema", "--out", `${output}/schema`]);
const version = await new Promise((resolve, reject) => {
  const child = spawn("codex", ["--version"]);
  let value = "";
  child.stdout.on("data", (chunk) => { value += chunk; });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve(value.trim()) : reject(new Error(`codex exited with ${code}`)));
});
await writeFile(`${output}/metadata.json`, JSON.stringify({ codexVersion: version, generatedAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`Generated Codex protocol artifacts for ${version}`);
