import { describe, expect, it } from "vitest";
import { resolveLocalFileHref } from "./fileLinks";

describe("conversation file links", () => {
  it("keeps external and in-page links as normal links", () => {
    expect(resolveLocalFileHref("https://example.com/a.ts", "/workspace")).toBeNull();
    expect(resolveLocalFileHref("#section", "/workspace")).toBeNull();
  });

  it("resolves absolute links and removes Codex line suffixes", () => {
    expect(resolveLocalFileHref("/mnt/data/project/app.ts:42", "/workspace")).toBe("/mnt/data/project/app.ts");
    expect(resolveLocalFileHref("/mnt/data/project/app.ts#L42C3", "/workspace")).toBe("/mnt/data/project/app.ts");
  });

  it("resolves relative links against the active thread cwd", () => {
    expect(resolveLocalFileHref("../docs/README.md:7", "/workspace/src")).toBe("/workspace/docs/README.md");
    expect(resolveLocalFileHref("apps/web/My%20File.tsx", "/workspace")).toBe("/workspace/apps/web/My File.tsx");
  });
});
