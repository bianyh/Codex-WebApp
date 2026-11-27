import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveUpload } from "./upload.js";

describe("streamed uploads", () => {
  let directory: string;
  let destination: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "codex-upload-test-"));
    destination = path.join(directory, "测试文件.bin");
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("streams a file larger than 25 MiB without exposing a partial final file", async () => {
    const block = Buffer.alloc(1024 * 1024, 0xa5);
    const body = Readable.from((async function* () {
      for (let index = 0; index < 32; index++) {
        if (index === 28) expect(await readdir(directory)).not.toContain(path.basename(destination));
        yield block;
      }
    })());
    const size = 32 * block.length;
    expect((await saveUpload(body, destination, String(size))).size).toBe(size);
    expect(await readdir(directory)).toEqual([path.basename(destination)]);
    const uploaded = await readFile(destination);
    expect(uploaded.length).toBe(size);
    for (let offset = 0; offset < size; offset += block.length) {
      expect(uploaded.subarray(offset, offset + block.length).equals(block)).toBe(true);
    }
  });

  it("keeps an existing file unchanged", async () => {
    await writeFile(destination, "original");
    await expect(saveUpload(Readable.from([Buffer.from("replacement")]), destination)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual([path.basename(destination)]);
  });

  it("cleans up after a disconnected client, truncated input, or empty body", async () => {
    const interrupted = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw new Error("aborted");
    })());
    await expect(saveUpload(interrupted, destination)).rejects.toThrow("aborted");
    await expect(saveUpload(Readable.from([Buffer.from("short")]), destination, "20")).rejects.toMatchObject({ code: "incomplete_upload" });
    await expect(saveUpload(Readable.from([]), destination)).rejects.toMatchObject({ code: "empty_upload" });
    expect(await readdir(directory)).toEqual([]);
  });
});
