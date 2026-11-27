import { link, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

export class UploadBodyError extends Error {
  constructor(readonly code: "empty_upload" | "incomplete_upload", message: string) { super(message); }
}

export async function saveUpload(source: Readable, destination: string, contentLength?: string) {
  if (contentLength === "0") throw new UploadBodyError("empty_upload", "上传文件不能为空");
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".codex-upload-"));
  const partial = path.join(temporary, "body");
  try {
    const file = await open(partial, "wx", 0o600);
    let metadata;
    try {
      await file.writeFile(source.iterator({ destroyOnReturn: false }));
      metadata = await file.stat();
      if (metadata.size === 0) throw new UploadBodyError("empty_upload", "上传文件不能为空");
      if (contentLength !== undefined && metadata.size !== Number(contentLength)) {
        throw new UploadBodyError("incomplete_upload", "文件未完整接收，请重新上传");
      }
    } finally {
      await file.close();
    }
    await link(partial, destination);
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
