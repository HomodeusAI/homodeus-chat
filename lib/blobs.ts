import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ReadStream } from "node:fs";
import { BLOB_ROOT, MAX_UPLOAD_BYTES } from "./config";

// The single blob boundary. Default is the filesystem, content-addressed by sha256 (free dedupe,
// immutable, perfect ETag). Swap to S3/R2 here without a schema change — the Postgres row, not the
// disk path, is canonical.
const shard = (sha: string) => join(BLOB_ROOT, sha.slice(0, 2), sha);

export class TooLargeError extends Error {
  constructor() {
    super("file exceeds the upload size cap");
    this.name = "TooLargeError";
  }
}

export interface PutResult {
  sha256: string;
  size: number;
  deduped: boolean;
}

// Stream bytes to disk while hashing + counting; reject past the cap; dedupe by content address.
export async function putBlob(body: AsyncIterable<Uint8Array>): Promise<PutResult> {
  await mkdir(join(BLOB_ROOT, "tmp"), { recursive: true });
  const tmp = join(BLOB_ROOT, "tmp", randomUUID());
  const hash = createHash("sha256");
  const out = createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (MAX_UPLOAD_BYTES && size > MAX_UPLOAD_BYTES) throw new TooLargeError();
      hash.update(chunk);
      if (!out.write(chunk))
        await new Promise<void>((res, rej) => {
          const onDrain = () => {
            out.off("error", onError);
            res();
          };
          const onError = (e: Error) => {
            out.off("drain", onDrain);
            rej(e);
          };
          out.once("drain", onDrain);
          out.once("error", onError); // a write error during backpressure rejects instead of hanging
        });
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    const sha256 = hash.digest("hex");
    try {
      await stat(shard(sha256)); // bytes already present
      await unlink(tmp);
      return { sha256, size, deduped: true };
    } catch {
      await mkdir(join(BLOB_ROOT, sha256.slice(0, 2)), { recursive: true });
      await rename(tmp, shard(sha256));
      return { sha256, size, deduped: false };
    }
  } catch (e) {
    out.destroy();
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export const blobStat = (sha256: string) => stat(shard(sha256));
export const blobStream = (sha256: string, range?: { start: number; end: number }): ReadStream =>
  createReadStream(shard(sha256), range);
