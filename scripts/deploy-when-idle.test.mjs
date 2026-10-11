import { describe, expect, it } from "vitest";

describe("deferred deployment", () => {
  it("requires ready, known-idle state and refuses pending work", async () => {
    const { isIdleHealth } = await import("./deploy-when-idle.mjs");
    const ready = { ok: true, data: { ok: true, appServer: "ready", activeThreads: 0 } };
    expect(isIdleHealth(ready)).toBe(true);
    expect(isIdleHealth(undefined)).toBe(false);
    expect(isIdleHealth({ ...ready, data: { ...ready.data, activeThreads: 1 } })).toBe(false);
    for (const key of ["activeCommands", "queuedTurns", "pendingRequests", "turnOperations"]) {
      expect(isIdleHealth({ ...ready, data: { ...ready.data, [key]: 1 } })).toBe(false);
    }
  });
  it("resets the idle window on busy state and failed health checks", async () => {
    const { waitForIdle } = await import("./deploy-when-idle.mjs");
    const idle = { ok: true, data: { ok: true, appServer: "ready", activeThreads: 0 } };
    const states = [idle, { ok: true, data: { ...idle.data, activeThreads: 1 } }, idle, undefined, idle, idle, idle];
    let calls = 0;
    await waitForIdle({ requiredSamples: 3, readHealth: async () => states[calls++], sleep: async () => {} });
    expect(calls).toBe(7);
  });
});
