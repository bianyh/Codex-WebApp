import { describe, expect, it } from "vitest";
import { formatMessageTimestamp } from "./messageTime";

describe("message timestamps", () => {
  it("formats an ISO timestamp as yy-mm-dd-hh-mm-ss", () => {
    const value = new Date("2024-01-02T03:04:05+08:00");
    const pad = (part: number) => String(part).padStart(2, "0");
    expect(formatMessageTimestamp(value.toISOString())).toBe(`${pad(value.getFullYear() % 100)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}-${pad(value.getHours())}-${pad(value.getMinutes())}-${pad(value.getSeconds())}`);
  });

  it("pads single digit date parts", () => {
    expect(formatMessageTimestamp("2001-02-03T04:05:06Z")).toMatch(/^01-02-03-\d{2}-\d{2}-\d{2}$/);
  });

  it("handles missing or invalid timestamps", () => {
    expect(formatMessageTimestamp()).toBe("时间未知");
    expect(formatMessageTimestamp("not-a-date")).toBe("时间未知");
  });
});
