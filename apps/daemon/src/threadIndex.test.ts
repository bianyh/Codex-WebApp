import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProcess } from "./codex.js";
import { ThreadIndexReconciler } from "./threadIndex.js";

afterEach(() => vi.useRealTimers());

describe("fast thread list protocol", () => {
  it("uses state-DB-only reads for interactive and paginated lists", async () => {
    const adapter = new CodexProcess();
    const rpc = vi.spyOn(adapter, "request").mockResolvedValue({ data: [{ id: "t", name: "Thread" }], nextCursor: "next" });
    expect(await adapter.listThreads("/tmp")).toMatchObject([{ id: "t" }]);
    expect(rpc).toHaveBeenLastCalledWith("thread/list", expect.objectContaining({ useStateDbOnly: true, cwd: "/tmp" }));
    expect(await adapter.listThreadPage({ cursor: "cursor", archived: true, searchTerm: "Thread" })).toMatchObject({ nextCursor: "next" });
    expect(rpc).toHaveBeenLastCalledWith("thread/list", expect.objectContaining({ useStateDbOnly: true, archived: true, cursor: "cursor", searchTerm: "Thread" }));
    await adapter.listThreadPage({ archived: false }, { useStateDbOnly: false });
    expect(rpc).toHaveBeenLastCalledWith("thread/list", expect.objectContaining({ useStateDbOnly: false }));
  });
  it("does not transfer duplicate full history when taking control or sending", async () => {
    const adapter = new CodexProcess();
    const rpc = vi.spyOn(adapter, "request").mockResolvedValue({ model: "test", turn: { id: "turn" } });
    expect(await adapter.tryTakeControl("existing")).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("thread/resume", { threadId: "existing", excludeTurns: true });
    await adapter.startTurn("another", { text: "continue", attachments: [] });
    expect(rpc).toHaveBeenCalledWith("thread/resume", { threadId: "another", excludeTurns: true });
  });
});

describe("background thread index", () => {
  it("defers scans, deduplicates concurrent clients and notifies after completion", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const scan = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const updated = vi.fn();
    const index = new ThreadIndexReconciler({ scan, updated, failed: vi.fn() });
    expect(index.request(false)).toBe(true);
    expect(index.request(false)).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledExactlyOnceWith(false);
    expect(index.request(false, true)).toBe(false);
    expect(updated).not.toHaveBeenCalled();
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(updated).toHaveBeenCalledExactlyOnceWith(false);
    expect(index.request(false)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(index.request(false)).toBe(true);
    index.close();
  });

  it("serializes recent and archived scans and allows an explicit refresh", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const scan = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const index = new ThreadIndexReconciler({ scan, updated: vi.fn(), failed: vi.fn() });
    index.request(false); index.request(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(scan.mock.calls).toEqual([[false]]);
    finish(); await vi.advanceTimersByTimeAsync(2000);
    expect(scan.mock.calls).toEqual([[false], [true]]);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(index.request(false)).toBe(false);
    expect(index.request(false, true)).toBe(true);
    index.close();
  });

  it("catches scan failures without retry storms and retries after cooldown", async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockRejectedValue(new Error("unavailable"));
    const updated = vi.fn(); const failed = vi.fn();
    const index = new ThreadIndexReconciler({ scan, updated, failed });
    index.request(false); await vi.advanceTimersByTimeAsync(2000);
    expect(failed).toHaveBeenCalledOnce(); expect(updated).not.toHaveBeenCalled();
    expect(index.request(false)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    scan.mockResolvedValue(undefined);
    expect(index.request(false)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(updated).toHaveBeenCalledOnce();
    index.close();
  });

  it("cancels deferred work and suppresses updates after shutdown", async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockResolvedValue(undefined);
    const index = new ThreadIndexReconciler({ scan, updated: vi.fn(), failed: vi.fn() });
    index.request(false); index.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(scan).not.toHaveBeenCalled(); expect(index.request(false, true)).toBe(false);

    let finish!: () => void;
    const updated = vi.fn();
    const active = new ThreadIndexReconciler({ scan: () => new Promise<void>((resolve) => { finish = resolve; }), updated, failed: vi.fn() });
    active.request(false); await vi.advanceTimersByTimeAsync(2000);
    active.close(); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(updated).not.toHaveBeenCalled();
  });
});
