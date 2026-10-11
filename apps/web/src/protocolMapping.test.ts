import { describe, expect, it } from "vitest";
import { changeStatusFromRaw, planFromRaw, tokenUsageFromRaw } from "./protocolMapping";
import { responseForRequest } from "./requestResponse";
import type { RequestItem } from "./types";

describe("Codex 0.162 protocol presentation", () => {
  it("reads both legacy and structured file-change kinds", () => {
    expect(changeStatusFromRaw("update")).toBe("update");
    expect(changeStatusFromRaw({ type: "update", move_path: "/tmp/new" })).toBe("update");
    expect(changeStatusFromRaw(null)).toBeUndefined();
  });
  it("maps plan step/status fields and tolerates unknown entries", () => {
    expect(planFromRaw([{ step: "Inspect", status: "completed" }, { step: "Build", status: "inProgress" }, null])).toEqual([{ text: "Inspect", completed: true }, { text: "Build", completed: false }]);
    expect(planFromRaw([{ text: "Legacy", completed: true }])).toEqual([{ text: "Legacy", completed: true }]);
  });
  it("flattens nested token totals into displayable numbers", () => {
    expect(tokenUsageFromRaw({ total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, last: {} })).toEqual({ input: 10, output: 5, total: 15 });
    expect(tokenUsageFromRaw({ input: 2, output: 3, total: 5 })).toEqual({ input: 2, output: 3, total: 5 });
    expect(tokenUsageFromRaw({ total: {} })).toEqual({ input: undefined, output: undefined, total: undefined });
  });
});

describe("typed server-request replies", () => {
  const request = (kind: string): RequestItem => ({ id: 1, kind, title: "Approval", createdAt: "2026-01-01T00:00:00Z" });
  it("grants only requested permissions for the current turn", () => {
    const input = { ...request("permissions"), permissions: { network: { enabled: true }, fileSystem: null } };
    expect(responseForRequest(input, "accept")).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(responseForRequest(input, "decline")).toEqual({ permissions: {}, scope: "turn" });
  });
  it("returns the MCP elicitation action instead of an approval decision", () => {
    expect(responseForRequest({ ...request("elicitation"), detail: '{"name":"test"}' }, "accept")).toEqual({ action: "accept", content: { name: "test" }, _meta: null });
    expect(responseForRequest(request("elicitation"), "decline")).toEqual({ action: "decline", content: null, _meta: null });
  });
  it("keeps free-text guidance in user-input answers", () => {
    expect(responseForRequest({ ...request("user_input"), questions: [{ id: "q1", question: "Choose" }], detail: JSON.stringify({ answers: { q1: "Yes" }, freeText: "with tests" }) }, "answer")).toEqual({ answers: { q1: { answers: ["Yes\nwith tests"] } } });
  });
});
