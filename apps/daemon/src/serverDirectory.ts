import path from "node:path";
import { realpath, stat } from "node:fs/promises";

export async function resolveServerPath(value: string, baseDirectory: string): Promise<string> {
  const candidate = path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
  return realpath(candidate);
}

export async function resolveServerDirectory(value: string, baseDirectory: string): Promise<string> {
  const resolved = await resolveServerPath(value, baseDirectory);
  if (!(await stat(resolved)).isDirectory()) throw new Error("路径不是文件夹");
  return resolved;
}
