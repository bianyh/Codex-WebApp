import { describe, expect, it } from "vitest";
import { createCommandId } from "./commandId";

describe("command identifiers", () => {
  it("uses native randomUUID when available", () => {
    expect(createCommandId({ randomUUID: () => "native-id" })).toBe("native-id");
  });

  it("falls back when randomUUID is unavailable on an HTTP LAN origin", () => {
    const identifier = createCommandId({
      getRandomValues: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });
    expect(identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identifier).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("still generates an ID when Web Crypto is unavailable", () => {
    expect(createCommandId({})).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
