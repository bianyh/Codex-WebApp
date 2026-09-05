import { useState } from "react";
import { CircleAlert, LoaderCircle, Play, Terminal, Trash2 } from "lucide-react";

type CommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

async function executeCommand(cwd: string, command: string): Promise<CommandResult> {
  const response = await fetch("/api/commands", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, command }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "命令执行失败");
  return body.data as CommandResult;
}

export function CommandPanel({ cwd }: { cwd?: string }) {
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<CommandResult[]>([]);

  const run = async () => {
    const value = command.trim();
    if (!cwd || !value || running) return;
    setRunning(true);
    setError("");
    try {
      const result = await executeCommand(cwd, value);
      setHistory((items) => [...items.slice(-19), result]);
      setCommand("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "命令执行失败");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="command-panel">
      <div className="command-toolbar">
        <Terminal size={14} />
        <code title={cwd}>{cwd ?? "未选择线程"}</code>
        <button disabled={history.length === 0 || running} onClick={() => setHistory([])} aria-label="清空命令输出" title="清空输出"><Trash2 size={14} /></button>
      </div>
      <div className="command-history" aria-live="polite">
        {history.length === 0 && <div className="empty-context"><Terminal size={15} />等待命令</div>}
        {history.map((result, index) => (
          <section className="command-result" key={`${result.command}-${index}-${result.durationMs}`}>
            <header><code>$ {result.command}</code><span className={result.exitCode === 0 ? "success" : "failed"}>{result.timedOut ? "超时" : `exit ${result.exitCode}`} · {result.durationMs} ms</span></header>
            {(result.stdout || result.stderr) && <pre>{result.stdout}{result.stderr && <span className="command-stderr">{result.stderr}</span>}</pre>}
          </section>
        ))}
      </div>
      {error && <div className="command-error"><CircleAlert size={14} />{error}</div>}
      <div className="command-input-row">
        <span>$</span>
        <input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} disabled={!cwd || running} placeholder="pwd、ls -la、git status" aria-label="命令" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <button disabled={!cwd || !command.trim() || running} onClick={() => void run()} aria-label="执行命令" title="执行命令">{running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}</button>
      </div>
    </div>
  );
}
