import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxOutputBytes = 256 * 1024;
const commandTimeoutMs = 20_000;

export type WorkspaceCommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

export function parseCommandLine(value: string): string[] {
  if (!value.trim()) throw new Error("命令不能为空");
  if (value.length > 1000) throw new Error("命令不能超过 1000 个字符");
  if (/\r|\n|\0/.test(value)) throw new Error("一次只能执行一行命令");
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const character of value.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        result.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (escaping || quote) throw new Error("命令中的引号或转义符没有闭合");
  if (token) result.push(token);
  if (result.some((entry) => [";", "|", "||", "&&", ">", ">>", "<"].includes(entry))) {
    throw new Error("不支持管道、重定向或多条命令");
  }
  return result;
}

const lsShortOptions = /^-[AacdfghiklmnopqQrRsStuxX1]+$/;
const lsLongOptions = /^(--all|--almost-all|--directory|--human-readable|--inode|--long|--numeric-uid-gid|--reverse|--recursive|--size|--group-directories-first|--color=(always|auto|never)|--sort=(none|size|time|version|extension|width)|--time=(atime|access|use|ctime|status|birth|creation))$/;
const gitSubcommands = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files"]);
const unsafeGitArguments = /^(--output(?:=|$)|--ext-diff$|--no-index$|--exec-path(?:=|$)|--config-env(?:=|$)|--paginate$|-c$)/;
const gitBranchOptions = /^(--list$|--all$|-a$|--remotes$|-r$|--verbose$|-v$|-vv$|--contains(?:=|$)|--no-contains(?:=|$)|--merged(?:=|$)|--no-merged(?:=|$)|--sort=|--format=|--column(?:=|$)|--no-column$|--color(?:=|$)|--no-color$)/;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function validateLsArguments(args: string[], cwd: string, workspaceRoot: string): Promise<string[]> {
  let operands = false;
  for (const argument of args) {
    if (!operands && argument === "--") {
      operands = true;
      continue;
    }
    if (!operands && argument.startsWith("-")) {
      if (!lsShortOptions.test(argument) && !lsLongOptions.test(argument)) throw new Error(`ls 选项不受支持：${argument}`);
      continue;
    }
    const target = await realpath(path.resolve(cwd, argument));
    if (!isInside(workspaceRoot, target)) throw new Error("命令路径必须位于工作区内");
  }
  return ["--color=never", ...args];
}

function validateGitArguments(args: string[]): string[] {
  const [subcommand, ...rest] = args;
  if (!subcommand || !gitSubcommands.has(subcommand)) {
    throw new Error("仅支持 git status、diff、log、show、branch、rev-parse 和 ls-files");
  }
  if (rest.some((argument) => unsafeGitArguments.test(argument))) throw new Error("该 Git 选项不允许使用");
  if (subcommand === "branch" && rest.some((argument) => !argument.startsWith("-") || !gitBranchOptions.test(argument))) {
    throw new Error("git branch 仅支持查看分支的选项");
  }
  const safeDiffOptions = ["diff", "log", "show"].includes(subcommand)
    ? ["--no-ext-diff", "--no-textconv"]
    : [];
  return ["--no-pager", "-c", "core.fsmonitor=false", subcommand, ...safeDiffOptions, ...rest];
}

export async function runWorkspaceCommand(input: {
  command: string;
  cwd: string;
  workspaceRoot: string;
}): Promise<WorkspaceCommandResult> {
  const tokens = parseCommandLine(input.command);
  const [executable, ...rawArgs] = tokens;
  let args: string[];
  if (executable === "pwd") {
    if (rawArgs.length > 0) throw new Error("pwd 不接受参数");
    args = [];
  } else if (executable === "ls") {
    args = await validateLsArguments(rawArgs, input.cwd, input.workspaceRoot);
  } else if (executable === "git") {
    args = validateGitArguments(rawArgs);
  } else {
    throw new Error("仅支持 pwd、ls 和只读 Git 命令");
  }

  const startedAt = Date.now();
  try {
    const result = await execFileAsync(executable, args, {
      cwd: input.cwd,
      timeout: commandTimeoutMs,
      maxBuffer: maxOutputBytes,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        TERM: "dumb",
      },
    });
    return {
      command: input.command,
      cwd: input.cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (reason) {
    const error = reason as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string | number };
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("命令输出超过 256 KiB，已停止执行");
    return {
      command: input.command,
      cwd: input.cwd,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : error.message,
      exitCode: typeof error.code === "number" ? error.code : 1,
      timedOut: Boolean(error.killed || error.signal === "SIGTERM"),
      durationMs: Date.now() - startedAt,
    };
  }
}
