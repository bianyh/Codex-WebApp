import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import argon2 from "argon2";
import { WebSocket } from "ws";

const root = await mkdtemp(path.join(tmpdir(), "codex-console-smoke-"));
const home = path.join(root, "codex");
await mkdir(home);
let requests = 0;
const provider = createServer(async (request, response) => {
  if (!request.url.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  for await (const _chunk of request) {}
  requests += 1;
  const id = `resp_smoke_${requests}`;
  const message = { id: `msg_${requests}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Smoke reply ${requests}`, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, body) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  event("response.created", { response: { id, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  event("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text });
  event("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text: message.content[0].text });
  event("response.output_item.done", { output_index: 0, item: message });
  event("response.completed", { response: { id, status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  response.end();
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = provider.address().port;
await writeFile(path.join(home, "config.toml"), `model = "smoke-model"\nmodel_provider = "smoke"\n[model_providers.smoke]\nname = "Isolated smoke provider"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
const child = spawn(process.env.CODEX_COMMAND ?? "codex", ["app-server", "--listen", "stdio://"], { cwd: root, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
const notifications = [];
let sequence = 0;
let stderr = "";
let adapter;
let daemon;
child.stderr.on("data", (chunk) => { stderr += chunk; });
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  } else notifications.push(message);
});
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function completeTurn(threadId) {
  const { turn } = await rpc("turn/start", { threadId, input: [{ type: "text", text: "Say hello without tools", text_elements: [] }] });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const finished = notifications.find((event) => event.method === "turn/completed" && event.params.turn.id === turn.id);
    if (finished) { assert.equal(finished.params.turn.status, "completed"); return turn.id; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Turn did not complete");
}
try {
  const handshake = await rpc("initialize", { clientInfo: { name: "codex_console_smoke", version: "0.1.0" } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const { thread } = await rpc("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "read-only" });
  await completeTurn(thread.id);
  const lastTurnId = await completeTurn(thread.id);
  await rpc("thread/revert", { threadId: thread.id, beforeTurnId: lastTurnId });
  await completeTurn(thread.id);
  const turns = await rpc("thread/turns/list", { threadId: thread.id, sortDirection: "asc", itemsView: "full" });
  assert.equal(turns.data.length, 2);
  assert.equal(turns.data[1].status, "completed");
  console.log(JSON.stringify({ version: handshake.userAgent, historyMode: thread.historyMode, turns: turns.data.length, rollbackAndResend: "passed", localProviderRequests: requests }));
  const legacyId = randomUUID();
  const turnId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessions = path.join(home, "sessions", "2026", "01", "01");
  await mkdir(sessions, { recursive: true });
  const records = [
    { timestamp, type: "session_meta", payload: { id: legacyId, timestamp, cwd: root, originator: "codex_cli_rs", cli_version: "0.150.1", source: "cli", model_provider: "smoke" } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp, type: "event_msg", payload: { type: "user_message", message: "Legacy smoke message", images: [], local_images: [], text_elements: [] } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Legacy smoke message" }] } },
    { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Legacy smoke reply" }] } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  await writeFile(path.join(sessions, `rollout-2026-01-01T00-00-00-${legacyId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const resumed = await rpc("thread/resume", { threadId: legacyId });
  console.log("Legacy resume history:", resumed.thread.historyMode, resumed.thread.turns.length);
  const legacyTurnId = resumed.thread.turns.at(-1)?.id;
  assert.equal(legacyTurnId, turnId);
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await stopped;
  process.env.CODEX_HOME = home;
  process.env.CODEX_CWD = root;
  const { CodexProcess } = await import("../apps/daemon/src/codex.ts");
  adapter = new CodexProcess();
  await adapter.start();
  const replay = async (threadId) => {
    const events = [];
    const unsubscribe = adapter.onEvent((event) => events.push(event));
    try {
      const started = await adapter.startTurn(threadId, { text: "Revised message without tools", attachments: [] });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const completed = events.find((event) => event.sourceMethod === "turn/completed" && event.event.turn.id === started.turn.id);
        if (completed) { assert.equal(completed.event.turn.status, "completed"); return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Adapter resend did not complete");
    } finally { unsubscribe(); }
  };
  const modern = await adapter.rollbackLastTurn(thread.id);
  assert.equal(modern.thread.id, thread.id);
  await replay(modern.thread.id);
  assert.equal((await adapter.readThread(thread.id)).items.filter((item) => item.kind === "user").length, 2);
  const replacement = await adapter.rollbackLastTurn(legacyId);
  assert.notEqual(replacement.thread.id, legacyId);
  assert.equal(replacement.items.length, 0);
  await replay(replacement.thread.id);
  assert.equal((await adapter.readThread(legacyId)).items.filter((item) => item.kind === "user").length, 1);
  console.log("Adapter paginated rollback/resend and first-turn legacy branching: passed");
  const forked = await adapter.request("thread/fork", { threadId: legacyId });
  await replay(forked.thread.id);
  const multiTurnReplacement = await adapter.rollbackLastTurn(forked.thread.id);
  assert.notEqual(multiTurnReplacement.thread.id, forked.thread.id);
  assert.equal(multiTurnReplacement.items.filter((item) => item.kind === "user").length, 1);
  await replay(multiTurnReplacement.thread.id);
  console.log("Adapter multi-turn legacy branching and resend: passed");
  await adapter.stop();
  const dataDir = path.join(root, "console-state");
  await mkdir(dataDir);
  const password = randomUUID();
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ passwordHash: await argon2.hash(password), sessions: [], projects: [], preferences: {} }), { mode: 0o600 });
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const repo = path.resolve(import.meta.dirname, "..");
  daemon = spawn(process.execPath, ["--import", "tsx", "apps/daemon/src/index.ts"], { cwd: repo, env: { ...process.env, CODEX_CONSOLE_HOST: "127.0.0.1", CODEX_CONSOLE_PORT: String(port), CODEX_CONSOLE_DATA_DIR: dataDir, LOG_LEVEL: "silent" }, stdio: ["ignore", "ignore", "pipe"] });
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => { daemonError += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const health = await (await fetch(`${base}/api/healthz`)).json(); if (health.data?.appServer === "ready") { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `Isolated daemon did not start: ${daemonError.slice(-1800)}`);
  const loggedIn = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers.get("set-cookie").split(";")[0];
  for (const targetId of [thread.id, legacyId]) {
    const loaded = await fetch(`${base}/api/threads/${targetId}`, { headers: { cookie } });
    assert.equal(loaded.status, 200);
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { cookie, origin: base } });
    const events = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "subscribe_thread", threadId: targetId }));
    for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "thread_snapshot"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    socket.send(JSON.stringify({ type: "retry_last_turn", threadId: targetId, text: "Revised through daemon" }));
    for (let attempt = 0; attempt < 200 && !events.some((event) => event.event?.method === "turn/completed"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const failure = events.find((event) => event.type === "error");
    assert.equal(failure, undefined, failure?.error?.message);
    const completed = events.find((event) => event.event?.method === "turn/completed");
    assert.equal(completed?.event.params.turn.status, "completed", "Daemon retry did not complete");
    if (targetId === legacyId) assert.ok(events.some((event) => event.replacesThreadId === legacyId));
    socket.close();
  }
  console.log("Authenticated daemon WebSocket rollback/resend: paginated and legacy passed");
} catch (error) {
  console.error(error.stack);
  if (stderr) console.error(stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  if (adapter) await adapter.stop();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await exited;
  }
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
