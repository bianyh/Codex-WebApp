import os from "node:os";
import path from "node:path";

export const config = {
  host: process.env.CODEX_CONSOLE_HOST ?? "127.0.0.1",
  port: Number(process.env.CODEX_CONSOLE_PORT ?? 8787),
  origin: process.env.CODEX_CONSOLE_ORIGIN ?? "",
  dataDir: process.env.CODEX_CONSOLE_DATA_DIR ?? path.join(os.homedir(), ".local", "state", "codex-console"),
  codexCommand: process.env.CODEX_COMMAND ?? "codex",
  codexCwd: process.env.CODEX_CWD ?? process.cwd(),
  workspaceRoot: path.resolve(process.env.CODEX_WORKSPACE_ROOT ?? path.dirname(process.cwd())),
  sessionDays: Number(process.env.CODEX_CONSOLE_SESSION_DAYS ?? 7),
};

export function allowedOrigin(requestOrigin?: string): boolean {
  if (!requestOrigin) return false;
  if (config.origin) return requestOrigin === config.origin;
  return requestOrigin.startsWith("http://127.0.0.1:") || requestOrigin.startsWith("http://localhost:") || requestOrigin.startsWith("http://192.168.") || requestOrigin.startsWith("http://10.") || requestOrigin.startsWith("https://");
}
