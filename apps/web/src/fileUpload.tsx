import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Upload } from "lucide-react";

export function useFileDrop(onFiles: (files: FileList) => void, onError: (message: string) => void, blockedReason?: string) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const acceptsFiles = (event: DragEvent<HTMLDivElement>) => event.dataTransfer.types.includes("Files");

  const handlers = {
    onDragEnter(event: DragEvent<HTMLDivElement>) {
      if (!acceptsFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLDivElement>) {
      if (!acceptsFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = blockedReason ? "none" : "copy";
      setDragging(true);
    },
    onDragLeave() {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(event: DragEvent<HTMLDivElement>) {
      depth.current = 0;
      setDragging(false);
      if (!acceptsFiles(event)) return;
      event.preventDefault();
      if (blockedReason) {
        onError(blockedReason);
        return;
      }
      const { files, items } = event.dataTransfer;
      if (Array.from(items).some((item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory)) {
        onError("请拖入文件，暂不支持拖入文件夹");
        return;
      }
      if (files.length > 0) onFiles(files);
    },
  };

  return { dragging, handlers };
}

export function FileDropHint({ message }: { message: string }) {
  return <div className="file-drop-hint" role="status"><span><Upload size={16} aria-hidden="true" />{message}</span></div>;
}

type Progress = { name: string; index: number; count: number; loaded: number; total: number; finishing: boolean };

function uploadFile<Result>(url: string, file: File, signal: AbortSignal, progress: (loaded: number) => void): Promise<Result> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.upload.onprogress = (event) => progress(Math.min(file.size, event.loaded));
    xhr.upload.onload = () => progress(file.size);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.ok === true) resolve(xhr.response.data as Result);
      else reject(new Error(xhr.response?.error?.message ?? (xhr.status === 413 ? "服务器或反向代理拒绝了这个文件的大小" : `无法上传 ${file.name}`)));
    };
    xhr.onerror = () => reject(new Error(`上传 ${file.name} 时连接中断`));
    xhr.onabort = () => reject(signal.reason);
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

export function useFileUploads() {
  const active = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const cancel = useCallback(() => active.current?.abort(), []);
  useEffect(() => cancel, [cancel]);

  async function upload<Result>(files: File[], endpoint: (file: File) => string, onSaved: (result: Result, file: File) => void) {
    if (active.current || !files.length) return;
    const empty = files.find((file) => file.size === 0);
    if (empty) throw new Error(`${empty.name} 是空文件`);
    const controller = new AbortController();
    active.current = controller;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    try {
      for (const [index, file] of files.entries()) {
        const base = completed;
        const update = (loaded: number) => setProgress({ name: file.name, index: index + 1, count: files.length, loaded: base + loaded, total, finishing: loaded === file.size });
        update(0);
        const result = await uploadFile<Result>(endpoint(file), file, controller.signal, update);
        if (controller.signal.aborted) break;
        onSaved(result, file);
        completed += file.size;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      active.current = null;
      setProgress(null);
    }
  }
  return { upload, progress, cancel, active };
}

export function FileUploadProgress({ progress }: { progress: Progress }) {
  const percent = Math.floor(progress.loaded / progress.total * 100);
  return <div className="file-upload-progress">
    <div className="file-upload-progress-label">
      <span title={progress.name}>{progress.index}/{progress.count} · {progress.name}</span>
      <span>{percent}%{progress.finishing ? " · 等待服务器确认" : ""}</span>
    </div>
    <progress max={progress.total} value={progress.loaded} aria-label="文件上传进度" />
  </div>;
}
