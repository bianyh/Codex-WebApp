import { spawn, type ChildProcess } from "node:child_process";

const maxOutputBytes = 1024 * 1024;
const commandTimeoutMs = 10 * 60_000;

export type WorkspaceCommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
  durationMs: number;
};

export function validateShellCommand(value: string): string {
  const command = value.trim();
  if (!command) throw new Error("命令不能为空");
  if (command.length > 16_000) throw new Error("命令不能超过 16000 个字符");
  if (command.includes("\0")) throw new Error("命令不能包含空字符");
  return command;
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* The process has already exited. */ }
  }
}

export function runWorkspaceCommand(input: {
  command: string;
  cwd: string;
  shell: string;
  signal?: AbortSignal;
}): Promise<WorkspaceCommandResult> {
  const command = validateShellCommand(input.command);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let aborted = input.signal?.aborted ?? false;
    let outputTruncated = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(input.shell, ["-c", command], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
    });

    const stop = () => {
      terminateProcessGroup(child, "SIGTERM");
      killTimer ??= setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 1500);
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) return;
      const value = chunk.subarray(0, remaining);
      outputBytes += value.length;
      if (target === "stdout") stdout += value.toString("utf8");
      else stderr += value.toString("utf8");
      if (value.length < chunk.length || outputBytes >= maxOutputBytes) {
        outputTruncated = true;
        stop();
      }
    };
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      if (timedOut) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}命令运行超过 10 分钟，已中止。\n`;
      if (aborted) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}命令已由用户中止。\n`;
      if (outputTruncated) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}命令输出超过 1 MiB，已截断并中止。\n`;
      resolve({ command, cwd: input.cwd, stdout, stderr, exitCode, timedOut, aborted, outputTruncated, durationMs: Date.now() - startedAt });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, commandTimeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${error.message}\n`;
      finish(1);
    });
    child.once("close", (code, signal) => {
      const exitCode = typeof code === "number" ? code : timedOut ? 124 : aborted ? 130 : signal ? 128 : 1;
      finish(exitCode);
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (aborted) stop();
  });
}
