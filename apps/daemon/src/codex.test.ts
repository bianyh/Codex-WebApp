import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorTextFromRaw, itemFromRaw, summaryFromRaw, userInputFromTurn } from "./codex.js";
import { ExternalCodexController } from "./externalCodex.js";
import {
  parseLatestRolloutActivity,
  ThreadActivityTracker,
} from "./threadActivity.js";

describe("Codex protocol mapping", () => {
  it("maps uploaded attachments to native Codex user input", () => {
    expect(userInputFromTurn({
      text: "inspect these",
      attachments: [
        { name: "screen.png", path: "/tmp/screen.png", mime: "image/png", size: 10, kind: "image" },
        { name: "notes.txt", path: "/tmp/notes.txt", mime: "text/plain", size: 20, kind: "file" },
      ],
    })).toEqual([
      { type: "text", text: "inspect these", text_elements: [] },
      { type: "localImage", path: "/tmp/screen.png" },
      { type: "mention", name: "notes.txt", path: "/tmp/notes.txt" },
    ]);
  });

  it("maps thread summaries into stable UI fields", () => {
    const result = summaryFromRaw({ id: "thread-1", preview: "hello", cwd: "/workspace", status: { type: "notLoaded" }, updatedAt: 1_700_000_000 });
    expect(result).toMatchObject({ id: "thread-1", title: "hello", cwd: "/workspace", status: "idle" });
    expect(result.updatedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("keeps approval and user-input waits as active statuses", () => {
    expect(summaryFromRaw({ id: "approval", status: { type: "active", activeFlags: ["waitingOnApproval"] } }).status).toBe("waiting_approval");
    expect(summaryFromRaw({ id: "input", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }).status).toBe("waiting_input");
  });

  it("maps common app-server items without exposing raw protocol to the UI", () => {
    expect(itemFromRaw({ type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] })).toMatchObject({ id: "u1", kind: "user", text: "hello" });
    expect(itemFromRaw({ type: "commandExecution", id: "c1", command: "ls", aggregatedOutput: "file.txt", status: "completed" })).toMatchObject({ id: "c1", kind: "command", command: "ls", output: "file.txt" });
    expect(itemFromRaw({ type: "futureItem", id: "x1" })).toMatchObject({ id: "x1", kind: "unknown", title: "futureItem" });
  });

  it("extracts useful details from failed Codex turns", () => {
    expect(errorTextFromRaw({ message: "context window exceeded", additionalDetails: "Try a shorter prompt" })).toBe("context window exceeded\nTry a shorter prompt");
    expect(errorTextFromRaw({ codexErrorInfo: "serverOverloaded" })).toBe("serverOverloaded");
    expect(errorTextFromRaw(undefined)).toBe("Codex 执行失败，未返回详细错误信息");
  });

  it("extracts changed files and diffs from completed fileChange items", () => {
    expect(itemFromRaw({ type: "fileChange", id: "f1", status: "completed", changes: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@" }] })).toMatchObject({ id: "f1", kind: "file_change", path: "src/app.ts", diff: "@@ -1 +1 @@", metadata: { changes: [{ path: "src/app.ts", kind: "update" }] } });
  });
});

describe("cross-window thread activity", () => {
  it("recognizes an unfinished external turn from rollout events", () => {
    const text = [
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "active-turn" } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
    ].join("\n");
    expect(parseLatestRolloutActivity("thread-1", text)).toEqual({ threadId: "thread-1", status: "running", activeTurnId: "active-turn" });
  });

  it("clears running state after completion or interruption", () => {
    const completed = `${JSON.stringify({ payload: { type: "task_started", turn_id: "turn-1" } })}\n${JSON.stringify({ payload: { type: "task_complete", turn_id: "turn-1" } })}`;
    const interrupted = `${JSON.stringify({ payload: { type: "task_started", turn_id: "turn-2" } })}\n${JSON.stringify({ payload: { type: "turn_aborted", turn_id: "turn-2" } })}`;
    expect(parseLatestRolloutActivity("thread-1", completed)?.status).toBe("idle");
    expect(parseLatestRolloutActivity("thread-1", interrupted)?.status).toBe("interrupted");
  });

  it("does not preserve a stale running status without a live owner", async () => {
    const tracker = new ThreadActivityTracker(
      () => false,
      async () => null,
    );
    await expect(
      tracker.inspect({
        id: "thread-1",
        title: "stale",
        status: "running",
      }),
    ).resolves.toMatchObject({
      status: "idle",
      canInterrupt: false,
      activeTurnId: undefined,
      activitySource: undefined,
    });
  });

  it("keeps a locally owned approval wait interruptible", async () => {
    const tracker = new ThreadActivityTracker(
      () => true,
      async () => null,
    );
    await expect(
      tracker.inspect({
        id: "thread-approval",
        title: "approval",
        status: "waiting_approval",
        activeTurnId: "turn-approval",
      }),
    ).resolves.toMatchObject({
      status: "waiting_approval",
      activeTurnId: "turn-approval",
      canInterrupt: true,
      activitySource: "console",
    });
  });

  it("recognizes an unfinished turn owned by an external app-server", async () => {
    const rolloutRoot = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
    const rolloutPath = path.join(rolloutRoot, "rollout-test.jsonl");
    await writeFile(
      rolloutPath,
      JSON.stringify({
        payload: { type: "task_started", turn_id: "app-server-turn" },
      }),
    );
    const tracker = new ThreadActivityTracker(
      () => false,
      async () => ({ active: false, kind: "app-server" }),
    );
    try {
      await expect(
        tracker.inspect({
          id: "thread-1",
          title: "app-server",
          status: "running",
          rolloutPath,
        }),
      ).resolves.toMatchObject({
        status: "running",
        activeTurnId: "app-server-turn",
        canInterrupt: true,
        activitySource: "external",
      });

      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            payload: { type: "task_started", turn_id: "app-server-turn" },
          }),
          JSON.stringify({
            payload: { type: "task_complete", turn_id: "app-server-turn" },
          }),
        ].join("\n"),
      );
      await expect(
        tracker.inspect({
          id: "thread-1",
          title: "app-server",
          status: "running",
          rolloutPath,
        }),
      ).resolves.toMatchObject({
        status: "idle",
        activeTurnId: undefined,
        canInterrupt: false,
        activitySource: undefined,
      });
    } finally {
      await rm(rolloutRoot, { recursive: true, force: true });
    }
  });

  it("shares one process scan and detects an interruptible external turn", async () => {
    const procRoot = await mkdtemp(path.join(os.tmpdir(), "codex-proc-"));
    const rolloutPath = path.join(
      procRoot,
      "home",
      ".codex",
      "sessions",
      "rollout-test.jsonl",
    );
    const ownerPid = 101;
    const inhibitorPid = 202;
    const ownerRoot = path.join(procRoot, String(ownerPid));
    const inhibitorRoot = path.join(procRoot, String(inhibitorPid));
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await writeFile(
      rolloutPath,
      JSON.stringify({
        payload: { type: "task_started", turn_id: "external-turn" },
      }),
    );
    await mkdir(path.join(ownerRoot, "fd"), { recursive: true });
    await mkdir(path.join(ownerRoot, "task", String(ownerPid)), {
      recursive: true,
    });
    await writeFile(
      path.join(ownerRoot, "cmdline"),
      "/usr/bin/codex\0--yolo\0test\0",
    );
    await writeFile(path.join(ownerRoot, "comm"), "codex\n");
    await writeFile(
      path.join(ownerRoot, "task", String(ownerPid), "children"),
      String(inhibitorPid),
    );
    await symlink(rolloutPath, path.join(ownerRoot, "fd", "9"));
    await mkdir(path.join(inhibitorRoot, "task", String(inhibitorPid)), {
      recursive: true,
    });
    await writeFile(
      path.join(inhibitorRoot, "cmdline"),
      "/usr/bin/systemd-inhibit\0--why\0Codex is running an active turn\0",
    );
    await writeFile(
      path.join(inhibitorRoot, "task", String(inhibitorPid), "children"),
      "",
    );

    let discoveryCount = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const controller = new ExternalCodexController({
      procRoot,
      cacheMs: 10_000,
      discoverPids: async () => {
        discoveryCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [ownerPid];
      },
      signalProcess: (pid, signal) => signals.push([pid, signal]),
    });

    try {
      const owners = await Promise.all(
        Array.from({ length: 40 }, () => controller.ownerFor(rolloutPath)),
      );
      expect(discoveryCount).toBe(1);
      expect(owners.every((owner) => owner?.pid === ownerPid && owner.active))
        .toBe(true);

      const tracker = new ThreadActivityTracker(
        () => false,
        (candidate) => controller.ownerFor(candidate),
      );
      await expect(
        tracker.inspect({
          id: "thread-1",
          title: "external",
          status: "running",
          rolloutPath,
        }),
      ).resolves.toMatchObject({
        status: "running",
        activeTurnId: "external-turn",
        canInterrupt: true,
        activitySource: "external",
      });

      await expect(controller.interrupt(rolloutPath)).resolves.toBe(true);
      expect(signals).toEqual([[ownerPid, "SIGINT"]]);
    } finally {
      await rm(procRoot, { recursive: true, force: true });
    }
  });
});
