import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Play, Square, Terminal, Trash2 } from "lucide-react";
import { createCommandId } from "./commandId";

type CommandResult = {
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

async function executeCommand(cwd: string, command: string, commandId: string): Promise<CommandResult> {
  const response = await fetch("/api/commands", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, command, commandId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "命令执行失败");
  return body.data as CommandResult;
}

async function stopCommand(commandId: string): Promise<void> {
  const response = await fetch(`/api/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) throw new Error(body?.error?.message ?? "无法中止命令");
}

export function CommandPanel({ cwd }: { cwd?: string }) {
  const [workingDirectory, setWorkingDirectory] = useState(cwd ?? "");
  const [command, setCommand] = useState("");
  const [runningCommandId, setRunningCommandId] = useState("");
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<CommandResult[]>([]);

  const run = async () => {
    const value = command.trim();
    const directory = workingDirectory.trim();
    if (!directory || !value || runningCommandId) return;
    setError("");
    let commandId = "";
    try {
      commandId = createCommandId();
      setRunningCommandId(commandId);
      const result = await executeCommand(directory, value, commandId);
      setHistory((items) => [...items.slice(-19), result]);
      setCommand("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "命令执行失败");
    } finally {
      setRunningCommandId("");
      setStopping(false);
    }
  };
  useEffect(() => {
    setWorkingDirectory(cwd ?? "");
  }, [cwd]);
  const stop = async () => {
    if (!runningCommandId || stopping) return;
    setStopping(true);
    setError("");
    try {
      await stopCommand(runningCommandId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法中止命令");
      setStopping(false);
    }
  };

  return (
    <div className="command-panel">
      <div className="command-toolbar">
        <Terminal size={14} />
        <input className="command-cwd-input" value={workingDirectory} onChange={(event) => setWorkingDirectory(event.target.value)} placeholder="输入任意服务器目录" aria-label="命令工作目录" title="命令会以此目录作为初始工作目录" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={Boolean(runningCommandId)} />
        <button disabled={history.length === 0 || Boolean(runningCommandId)} onClick={() => setHistory([])} aria-label="清空命令输出" title="清空输出"><Trash2 size={14} /></button>
      </div>
      <div className="command-history" aria-live="polite">
        {history.length === 0 && <div className="empty-context"><Terminal size={15} />等待命令</div>}
        {history.map((result, index) => (
          <section className="command-result" key={`${result.command}-${index}-${result.durationMs}`}>
            <header><code>$ {result.command}</code><span className={result.exitCode === 0 ? "success" : "failed"}>{result.aborted ? "已中止" : result.timedOut ? "超时" : result.outputTruncated ? "输出超限" : `exit ${result.exitCode}`} · {result.durationMs} ms</span></header>
            {(result.stdout || result.stderr) && <pre>{result.stdout}{result.stderr && <span className="command-stderr">{result.stderr}</span>}</pre>}
          </section>
        ))}
      </div>
      {error && <div className="command-error"><CircleAlert size={14} />{error}</div>}
      <div className="command-input-row">
        <span>$</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} disabled={!workingDirectory.trim() || Boolean(runningCommandId)} placeholder="输入 Shell 命令" aria-label="命令" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        {runningCommandId
          ? <button className="running" disabled={stopping} onClick={() => void stop()} aria-label="中止命令" title="中止命令">{stopping ? <LoaderCircle className="spin" size={15} /> : <Square size={14} fill="currentColor" />}</button>
          : <button disabled={!workingDirectory.trim() || !command.trim()} onClick={() => void run()} aria-label="执行命令" title="执行命令"><Play size={15} /></button>}
      </div>
    </div>
  );
}
