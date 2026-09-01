import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, readlink } from "node:fs/promises";

export type ExternalCodexOwner = {
  pid: number;
  active: boolean;
  command: string;
  kind: "cli" | "app-server";
};

type OwnerCache = {
  expiresAt: number;
  byRolloutPath: Map<string, ExternalCodexOwner>;
};

type ExternalCodexControllerOptions = {
  procRoot?: string;
  cacheMs?: number;
  discoverPids?: () => Promise<number[]>;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  isIgnoredPid?: (pid: number) => boolean;
};

const execFileAsync = promisify(execFile);

function parsePids(value: string): number[] {
  return [...new Set(value.trim().split(/\s+/).filter(Boolean).map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function normalizeRolloutPath(value: string): string {
  return path.resolve(value);
}

function isRolloutPath(value: string): boolean {
  const basename = path.basename(value);
  return basename.startsWith("rollout-") && basename.endsWith(".jsonl");
}

export class ExternalCodexController {
  private cache: OwnerCache = {
    expiresAt: 0,
    byRolloutPath: new Map(),
  };

  private scanPromise: Promise<Map<string, ExternalCodexOwner>> | null = null;
  private readonly procRoot: string;
  private readonly cacheMs: number;
  private readonly discoverPidsOverride?: () => Promise<number[]>;
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isIgnoredPid: (pid: number) => boolean;

  constructor(options: ExternalCodexControllerOptions = {}) {
    this.procRoot = options.procRoot ?? "/proc";
    this.cacheMs = options.cacheMs ?? 1_800;
    this.discoverPidsOverride = options.discoverPids;
    this.signalProcess =
      options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.isIgnoredPid = options.isIgnoredPid ?? (() => false);
  }

  private processPath(pid: number, ...parts: string[]): string {
    return path.join(this.procRoot, String(pid), ...parts);
  }

  private async readCommandArgs(pid: number): Promise<string[]> {
    try {
      return (await readFile(this.processPath(pid, "cmdline")))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async discoverPidsFromProc(): Promise<number[]> {
    const entries = await readdir(this.procRoot, { withFileTypes: true });
    const pids = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name));
    const matches: number[] = [];
    const batchSize = 128;
    for (let index = 0; index < pids.length; index += batchSize) {
      const batch = pids.slice(index, index + batchSize);
      const names = await Promise.all(
        batch.map(async (pid) => {
          try {
            const name = (
              await readFile(this.processPath(pid, "comm"), "utf8")
            ).trim();
            return name === "codex" ? pid : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const pid of names) if (pid) matches.push(pid);
    }
    return matches;
  }

  private async discoverPids(): Promise<number[]> {
    if (this.discoverPidsOverride) return this.discoverPidsOverride();
    if (this.procRoot === "/proc") {
      try {
        const result = await execFileAsync("pidof", ["codex"], {
          encoding: "utf8",
          timeout: 1_000,
          maxBuffer: 64 * 1024,
        });
        return parsePids(result.stdout);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException & { code?: string | number })
          .code;
        if (String(code) === "1") return [];
      }
    }
    return this.discoverPidsFromProc();
  }

  private async childPids(pid: number): Promise<number[]> {
    try {
      return parsePids(
        await readFile(
          this.processPath(pid, "task", String(pid), "children"),
          "utf8",
        ),
      );
    } catch {
      return [];
    }
  }

  private async hasActiveTurnDescendant(pid: number): Promise<boolean> {
    const pending = await this.childPids(pid);
    const visited = new Set<number>();
    while (pending.length && visited.size < 128) {
      const childPid = pending.shift();
      if (!childPid || visited.has(childPid)) continue;
      visited.add(childPid);
      const command = (await this.readCommandArgs(childPid)).join(" ");
      if (
        command.includes("systemd-inhibit") &&
        command.includes("Codex is running an active turn")
      ) {
        return true;
      }
      pending.push(...(await this.childPids(childPid)));
    }
    return false;
  }

  private async inspectProcess(
    pid: number,
  ): Promise<Array<[string, ExternalCodexOwner]>> {
    if (this.isIgnoredPid(pid)) return [];
    const args = await this.readCommandArgs(pid);
    if (!args.length) return [];

    let descriptors: string[];
    try {
      descriptors = await readdir(this.processPath(pid, "fd"));
    } catch {
      return [];
    }

    const command = args.join(" ");
    const kind = args.includes("app-server") ? "app-server" : "cli";
    const active = await this.hasActiveTurnDescendant(pid);
    const entries = await Promise.all(
      descriptors.map(async (descriptor) => {
        try {
          const target = await readlink(
            this.processPath(pid, "fd", descriptor),
          );
          if (!path.isAbsolute(target) || !isRolloutPath(target)) return null;
          return [
            normalizeRolloutPath(target),
            { pid, active, command, kind },
          ] as [string, ExternalCodexOwner];
        } catch {
          // File descriptor closed between readdir and readlink.
          return null;
        }
      }),
    );
    return entries.filter(
      (entry): entry is [string, ExternalCodexOwner] => Boolean(entry),
    );
  }

  private async refreshOwners(): Promise<Map<string, ExternalCodexOwner>> {
    const byRolloutPath = new Map<string, ExternalCodexOwner>();
    const processEntries = await Promise.all(
      (await this.discoverPids()).map((pid) => this.inspectProcess(pid)),
    );
    for (const [rolloutPath, owner] of processEntries.flat()) {
      const current = byRolloutPath.get(rolloutPath);
      if (!current || (!current.active && owner.active)) {
        byRolloutPath.set(rolloutPath, owner);
      }
    }
    this.cache = {
      expiresAt: Date.now() + this.cacheMs,
      byRolloutPath,
    };
    return byRolloutPath;
  }

  private async owners(
    forceRefresh = false,
  ): Promise<Map<string, ExternalCodexOwner>> {
    if (forceRefresh && this.scanPromise) {
      await this.scanPromise.catch(() => undefined);
    }
    if (forceRefresh) this.cache.expiresAt = 0;
    if (this.cache.expiresAt > Date.now()) return this.cache.byRolloutPath;
    if (this.scanPromise) return this.scanPromise;

    this.scanPromise = this.refreshOwners();
    try {
      return await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }

  async ownerFor(
    rolloutPath?: string,
    forceRefresh = false,
  ): Promise<ExternalCodexOwner | null> {
    if (!rolloutPath) return null;
    return (
      (await this.owners(forceRefresh)).get(
        normalizeRolloutPath(rolloutPath),
      ) ?? null
    );
  }

  async interrupt(
    rolloutPath?: string,
    allowUninhibitedAppServer = false,
  ): Promise<boolean> {
    const owner = await this.ownerFor(rolloutPath, true);
    const externallyActive =
      owner?.active ||
      (allowUninhibitedAppServer && owner?.kind === "app-server");
    if (!owner || !externallyActive) {
      this.cache.expiresAt = 0;
      return false;
    }
    if (owner.kind === "cli" && !(await this.hasActiveTurnDescendant(owner.pid))) {
      this.cache.expiresAt = 0;
      return false;
    }
    try {
      this.signalProcess(owner.pid, "SIGINT");
      this.cache.expiresAt = 0;
      return true;
    } catch {
      return false;
    }
  }

  async closeIdleOwner(rolloutPath?: string): Promise<boolean> {
    const owner = await this.ownerFor(rolloutPath, true);
    if (!owner || owner.active || (await this.hasActiveTurnDescendant(owner.pid))) {
      this.cache.expiresAt = 0;
      return false;
    }
    try {
      this.signalProcess(owner.pid, "SIGTERM");
      this.cache.expiresAt = 0;
      return true;
    } catch {
      return false;
    }
  }
}
