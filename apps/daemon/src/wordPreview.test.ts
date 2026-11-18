import { execFileSync } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWordPreview } from "./wordPreview.js";

const converter = "libreoffice";
const converterAvailable = (() => {
  try { execFileSync(converter, ["--version"], { stdio: "ignore", timeout: 3000 }); return true; } catch { return false; }
})();

describe("local Word preview conversion", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "word-preview-test-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rejects directories, non-Word files and oversized documents before conversion", async () => {
    await writeFile(path.join(root, "note.txt"), "not a Word document");
    const large = path.join(root, "large.docx");
    await writeFile(large, "");
    await truncate(large, 25 * 1024 * 1024 + 1);
    await expect(renderWordPreview(root, root, converter)).rejects.toMatchObject({ code: "not_file" });
    await expect(renderWordPreview("note.txt", root, converter)).rejects.toMatchObject({ code: "not_word" });
    await expect(renderWordPreview(large, root, converter)).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("indicates when the optional converter is missing", async () => {
    await writeFile(path.join(root, "word.doc"), "test fixture");
    await expect(renderWordPreview("word.doc", root, path.join(root, "missing"))).rejects.toMatchObject({ status: 503, code: "converter_unavailable" });
  });

  it.skipIf(!converterAvailable)("converts both DOC and DOCX with LibreOffice", async () => {
    const input = path.join(root, "会议纪要.txt");
    await writeFile(input, "Word preview\nSecond paragraph\n");
    for (const format of ["doc:MS Word 97", "docx:Office Open XML Text"]) {
      execFileSync(converter, [`-env:UserInstallation=${pathToFileURL(path.join(root, "fixture-profile")).href}`, "--headless", "--convert-to", format, "--outdir", root, input], { stdio: "ignore", timeout: 8000 });
      const pdf = await renderWordPreview(path.join(root, `会议纪要.${format.split(":")[0]}`), root, converter);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 20_000);
});
