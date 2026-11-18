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

export function isWordDocument(filePath: string): boolean {
  return [".doc", ".docx"].includes(path.extname(filePath).toLowerCase());
}

export class WordPreviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function convertWord(command: string, args: string[], directory: string): Promise<void> {
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
      reject(new Error("Word conversion timed out"));
    }, 25_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (status === 0) resolve();
      else reject(new Error("LibreOffice did not finish successfully"));
    });
  });
}

export async function renderWordPreview(value: string, cwd: string, command: string): Promise<Buffer> {
  const filePath = await resolveServerPath(value, cwd);
  const info = await stat(filePath);
  if (!info.isFile()) throw new WordPreviewError(400, "not_file", "所选路径不是文件");
  if (!isWordDocument(filePath)) throw new WordPreviewError(415, "not_word", "只支持 .doc 和 .docx 文档预览");
  if (info.size > maxInputBytes) throw new WordPreviewError(413, "file_too_large", "Word 文档超过 25 MiB，请下载后查看");

  const temporary = await mkdtemp(path.join(tmpdir(), "codex-console-word-"));
  const profile = path.join(temporary, "profile");
  const input = path.join(temporary, `document${path.extname(filePath).toLowerCase()}`);
  try {
    await mkdir(path.join(profile, "user"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(profile, "user", "registrymodifications.xcu"), securityProfile, { mode: 0o600 });
    await copyFile(filePath, input);
    try {
      await convertWord(command, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--convert-to", "pdf:writer_pdf_Export", "--outdir", temporary, input], temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WordPreviewError(503, "converter_unavailable", "服务器未配置 LibreOffice，暂不能预览 Word。请下载原文件查看。");
      throw new WordPreviewError(422, "conversion_failed", "Word 文档转换失败或超时，请下载原文件查看。");
    }

    const output = path.join(temporary, "document.pdf");
    const resultInfo = await stat(output).catch(() => undefined);
    if (!resultInfo?.isFile() || resultInfo.size === 0) throw new WordPreviewError(422, "conversion_failed", "无法预览此 Word 文档，文件可能损坏或受密码保护。请下载原文件查看。");
    if (resultInfo.size > maxOutputBytes) throw new WordPreviewError(413, "preview_too_large", "转换后的预览超过 50 MiB，请下载原文件查看。");
    return await readFile(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
