import { describe, expect, it } from "vitest";
import { createOptimisticUserItem, mergeTimelineItem, textFromRawItem } from "./messageState";

describe("optimistic user messages", () => {
  it("creates a visible local item before the server event arrives", () => {
    const item = createOptimisticUserItem("inspect this", ["notes.txt"]);
    expect(item).toMatchObject({ kind: "user", text: "inspect this" });
    expect(item.id).toMatch(/^local-user-/);
  });

  it("replaces the temporary item when the canonical user event arrives", () => {
    const local = createOptimisticUserItem("run tests");
    const canonical = { id: "server-user-1", kind: "user" as const, text: "run tests" };
    expect(mergeTimelineItem([local], canonical)).toEqual([canonical]);
  });

  it("extracts user text from app-server content blocks", () => {
    expect(textFromRawItem({
      type: "userMessage",
      content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }],
    })).toBe("hello world");
  });

  it("reconciles attachment-only messages without text", () => {
    const local = createOptimisticUserItem("", ["image.png"]);
    const canonical = { id: "server-user-attachment", kind: "user" as const };
    expect(mergeTimelineItem([local], canonical)).toEqual([{
      ...canonical,
      text: "附件：image.png",
    }]);
  });

  it("does not duplicate repeated messages", () => {
    const first = createOptimisticUserItem("same text");
    const second = createOptimisticUserItem("same text");
    const afterFirst = mergeTimelineItem([first, second], { id: "server-1", kind: "user", text: "same text" });
    const afterSecond = mergeTimelineItem(afterFirst, { id: "server-2", kind: "user", text: "same text" });
    expect(afterSecond.map((item) => item.id)).toEqual(["server-1", "server-2"]);
  });
});
