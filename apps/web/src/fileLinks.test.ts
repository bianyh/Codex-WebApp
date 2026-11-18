import { describe, expect, it } from "vitest";
import { resolveLocalFileHref } from "./fileLinks";

describe("conversation file links", () => {
  it("keeps external and in-page links as normal links", () => {
    expect(resolveLocalFileHref("https://example.com/a.ts", "/workspace")).toBeNull();
    expect(resolveLocalFileHref("//example.com/a.pdf#page=5", "/workspace")).toBeNull();
    expect(resolveLocalFileHref("#section", "/workspace")).toBeNull();
  });

  it("resolves absolute links and removes Codex line suffixes", () => {
    expect(resolveLocalFileHref("/mnt/data/project/app.ts:42", "/workspace")).toEqual({ path: "/mnt/data/project/app.ts" });
    expect(resolveLocalFileHref("/mnt/data/project/app.ts#L42C3", "/workspace")).toEqual({ path: "/mnt/data/project/app.ts" });
  });

  it("resolves relative links against the active thread cwd", () => {
    expect(resolveLocalFileHref("../docs/README.md:7", "/workspace/src")).toEqual({ path: "/workspace/docs/README.md" });
    expect(resolveLocalFileHref("README.md:7", "/workspace")).toEqual({ path: "/workspace/README.md" });
    expect(resolveLocalFileHref("apps/web/My%20File.tsx", "/workspace")).toEqual({ path: "/workspace/apps/web/My File.tsx" });
  });

  it("separates PDF page fragments from absolute, relative, and file URI paths", () => {
    expect(resolveLocalFileHref("/手册/接口实测版.pdf#page=5")).toEqual({ path: "/手册/接口实测版.pdf", pdfPage: 5 });
    expect(resolveLocalFileHref("A%20B.PDF#page=05&zoom=100", "/tmp")).toEqual({ path: "/tmp/A B.PDF", pdfPage: 5 });
    expect(resolveLocalFileHref("file:///tmp/report.pdf#page=2")).toEqual({ path: "/tmp/report.pdf", pdfPage: 2 });
    expect(resolveLocalFileHref("sandbox:/tmp/report.pdf#page=2")).toEqual({ path: "/tmp/report.pdf", pdfPage: 2 });
  });

  it("preserves percent-encoded filename hashes and ignores invalid page numbers", () => {
    expect(resolveLocalFileHref("/tmp/Report%23page=3.pdf#page=2")).toEqual({ path: "/tmp/Report#page=3.pdf", pdfPage: 2 });
    expect(resolveLocalFileHref("/tmp/actual.pdf%23page=5")).toEqual({ path: "/tmp/actual.pdf#page=5" });
    expect(resolveLocalFileHref("/tmp/Report.pdf#page=0")).toEqual({ path: "/tmp/Report.pdf" });
    expect(resolveLocalFileHref("/tmp/Report.pdf#page=9999999999999999999999")).toEqual({ path: "/tmp/Report.pdf" });
  });
});
