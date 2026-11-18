import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveServerPath } from "./serverDirectory.js";

const maxInputBytes = 25 * 1024 * 1024;
const maxOutputBytes = 50 * 1024 * 1024;
const securityProfile = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>0</value></prop>
    <prop oor:name="Field" oor:op="fuse"><value>false</value></prop>
  </item>
</oor:items>`;

const formats = {
  word: { label: "Word 文档", component: "Writer", extensions: [".doc", ".docx"], pdfFilter: "writer_pdf_Export" },
  presentation: { label: "PowerPoint 演示文稿", component: "Impress", extensions: [".ppt", ".pptx"], pdfFilter: "impress_pdf_Export" },
};

export type OfficePreviewKind = keyof typeof formats;

export function officePreviewKind(filePath: string): OfficePreviewKind | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (formats.word.extensions.includes(extension)) return "word";
  if (formats.presentation.extensions.includes(extension)) return "presentation";
}

export class OfficePreviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function convertOffice(command: string, args: string[], directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory, detached: process.platform !== "win32", stdio: "ignore",
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HOME: directory, TMPDIR: directory },
    });
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
      reject(new Error("Office conversion timed out"));
    }, 25_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (status === 0) resolve();
      else reject(new Error("LibreOffice did not finish successfully"));
    });
  });
}

export async function renderOfficePreview(value: string, cwd: string, command: string, kind: OfficePreviewKind): Promise<Buffer> {
  const format = formats[kind];
  const filePath = await resolveServerPath(value, cwd);
  const info = await stat(filePath);
  if (!info.isFile()) throw new OfficePreviewError(400, "not_file", "所选路径不是文件");
  if (officePreviewKind(filePath) !== kind) throw new OfficePreviewError(415, `not_${kind}`, `只支持 ${format.extensions.join(" 和 ")} 文件预览`);
  if (info.size > maxInputBytes) throw new OfficePreviewError(413, "file_too_large", `${format.label}超过 25 MiB，请下载后查看`);

  const temporary = await mkdtemp(path.join(tmpdir(), "codex-console-office-"));
  const profile = path.join(temporary, "profile");
  const input = path.join(temporary, `document${path.extname(filePath).toLowerCase()}`);
  try {
    await mkdir(path.join(profile, "user"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(profile, "user", "registrymodifications.xcu"), securityProfile, { mode: 0o600 });
    await copyFile(filePath, input);
    try {
      await convertOffice(command, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--convert-to", `pdf:${format.pdfFilter}`, "--outdir", temporary, input], temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new OfficePreviewError(503, "converter_unavailable", `服务器未配置 LibreOffice ${format.component}，暂不能预览。请下载原文件查看。`);
      throw new OfficePreviewError(422, "conversion_failed", `${format.label}转换失败或超时，请下载原文件查看。`);
    }

    const output = path.join(temporary, "document.pdf");
    const resultInfo = await stat(output).catch(() => undefined);
    if (!resultInfo?.isFile() || resultInfo.size === 0) throw new OfficePreviewError(422, "conversion_failed", `无法预览此${format.label}。请确认服务器已安装 LibreOffice ${format.component}，且文件未损坏或加密；也可以下载原文件查看。`);
    if (resultInfo.size > maxOutputBytes) throw new OfficePreviewError(413, "preview_too_large", "转换后的预览超过 50 MiB，请下载原文件查看。");
    return await readFile(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
