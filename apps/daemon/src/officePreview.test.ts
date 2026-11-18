import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { officePreviewKind, renderOfficePreview } from "./officePreview.js";

const converter = "libreoffice";
const converterAvailable = (() => {
  try { execFileSync(converter, ["--version"], { stdio: "ignore", timeout: 3000 }); return true; } catch { return false; }
})();

describe("local Office preview conversion", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "word-preview-test-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rejects directories, non-Word files and oversized documents before conversion", async () => {
    await writeFile(path.join(root, "note.txt"), "not a Word document");
    const large = path.join(root, "large.docx");
    await writeFile(large, "");
    await truncate(large, 25 * 1024 * 1024 + 1);
    await expect(renderOfficePreview(root, root, converter, "word")).rejects.toMatchObject({ code: "not_file" });
    await expect(renderOfficePreview("note.txt", root, converter, "word")).rejects.toMatchObject({ code: "not_word" });
    await expect(renderOfficePreview(large, root, converter, "presentation")).rejects.toMatchObject({ code: "not_presentation" });
    await expect(renderOfficePreview(large, root, converter, "word")).rejects.toMatchObject({ code: "file_too_large" });
    expect(officePreviewKind("/files/Slides.PPT")).toBe("presentation");
    expect(officePreviewKind("/files/Slides.PPTX")).toBe("presentation");
    expect(officePreviewKind("/files/Slides.pptm")).toBeUndefined();
  });

  it("indicates when the optional converter is missing", async () => {
    await writeFile(path.join(root, "word.doc"), "test fixture");
    await expect(renderOfficePreview("word.doc", root, path.join(root, "missing"), "word")).rejects.toMatchObject({ status: 503, code: "converter_unavailable" });
  });

  it.skipIf(!converterAvailable)("converts both DOC and DOCX with LibreOffice", async () => {
    const input = path.join(root, "会议纪要.txt");
    await writeFile(input, "Word preview\nSecond paragraph\n");
    for (const format of ["doc:MS Word 97", "docx:Office Open XML Text"]) {
      execFileSync(converter, [`-env:UserInstallation=${pathToFileURL(path.join(root, "fixture-profile")).href}`, "--headless", "--convert-to", format, "--outdir", root, input], { stdio: "ignore", timeout: 8000 });
      const pdf = await renderOfficePreview(path.join(root, `会议纪要.${format.split(":")[0]}`), root, converter, "word");
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    }
  }, 20_000);

  it.skipIf(!converterAvailable)("converts two-slide PPTX and PPT decks without dropping slides", async ({ skip }) => {
    const input = path.join(root, "演示文稿.fodp");
    await writeFile(input, `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
  <office:body><office:presentation>
    <draw:page draw:name="Slide 1"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="2cm"><draw:text-box><text:p>First slide</text:p></draw:text-box></draw:frame></draw:page>
    <draw:page draw:name="Slide 2"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="2cm"><draw:text-box><text:p>Second slide</text:p></draw:text-box></draw:frame></draw:page>
  </office:presentation></office:body>
</office:document>`);
    for (const [extension, filter] of [["pptx", "Impress MS PowerPoint 2007 XML"], ["ppt", "MS PowerPoint 97"]] as const) {
      execFileSync(converter, [`-env:UserInstallation=${pathToFileURL(path.join(root, "fixture-profile")).href}`, "--headless", "--convert-to", `${extension}:${filter}`, "--outdir", root, input], { stdio: "ignore", timeout: 8000 });
      const deck = path.join(root, `演示文稿.${extension}`);
      if (extension === "pptx" && !await access(deck).then(() => true, () => false)) {
        skip(true, "LibreOffice Impress is not available");
        return;
      }
      const pdf = await renderOfficePreview(deck, root, converter, "presentation");
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(2);
    }
  }, 20_000);
});
