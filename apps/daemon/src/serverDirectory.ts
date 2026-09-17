import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export async function resolveServerDirectory(value: string, baseDirectory: string): Promise<string> {
  const candidate = path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
  const resolved = await realpath(candidate);
  if (!(await stat(resolved)).isDirectory()) throw new Error("路径不是文件夹");
  return resolved;
}
