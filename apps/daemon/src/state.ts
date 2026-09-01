import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

type State = {
  passwordHash?: string;
  projects: Array<{ id: string; name: string; canonicalPath: string; enabled: boolean; defaultSettings?: Record<string, unknown> }>;
  sessions: Array<{ tokenHash: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt?: string }>;
  preferences: Record<string, unknown>;
};

const defaultState: State = { projects: [], sessions: [], preferences: {} };
let state: State = structuredClone(defaultState);
let initialized = false;

export async function loadState(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(config.dataDir, "state.json");
  try {
    state = JSON.parse(await readFile(filename, "utf8")) as State;
  } catch {
    state = structuredClone(defaultState);
  }
  initialized = true;
}

export async function persistState(): Promise<void> {
  if (!initialized) return;
  const filename = path.join(config.dataDir, "state.json");
  await writeFile(filename, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await chmod(filename, 0o600);
}

export function getState(): State { return state; }
