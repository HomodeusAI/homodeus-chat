import { Readable } from "node:stream";
import { authParticipantHeaderOrCookie } from "@/lib/auth";
import { attachmentMeta, attachmentDownloadableBy } from "@/lib/store";
import { blobStream } from "@/lib/blobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download a file. Authenticated (header or cookie, so observer <img> works), and gated: only the
// uploader or a member of a room where it was shared. Strong ETag (sha256), immutable cache, Range.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const p = await authParticipantHeaderOrCookie(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "bad id" }, { status: 400 });
  if (!(await attachmentDownloadableBy(id, p.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const meta = await attachmentMeta(id);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  // Only a strict allowlist is served inline; everything else (html, svg, scripts, ...) is forced to
  // an octet-stream attachment so an uploaded blob can never execute as script in the app's origin.
  // nosniff + a locked-down CSP are belt-and-suspenders.
  const INLINE_OK = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf"]);
  const inline = INLINE_OK.has(meta.content_type);
  const etag = `"${meta.sha256}"`;
  const headers = new Headers({
    "content-type": inline ? meta.content_type : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${meta.filename.replace(/["\r\n]/g, "")}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    etag,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
  });
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const total = meta.size;
    let start: number;
    let end: number;
    if (m && m[1] === "" && m[2] !== "") {
      start = Math.max(0, total - Number(m[2])); // suffix range: last N bytes
      end = total - 1;
    } else {
      start = m?.[1] ? Number(m[1]) : 0;
      end = m?.[2] ? Number(m[2]) : total - 1;
    }
    if (!m || start > end || end >= total || start < 0)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
    headers.set("content-length", String(end - start + 1));
    const web = Readable.toWeb(blobStream(meta.sha256, { start, end })) as unknown as ReadableStream;
    return new Response(web, { status: 206, headers });
  }
  headers.set("content-length", String(meta.size));
  const web = Readable.toWeb(blobStream(meta.sha256)) as unknown as ReadableStream;
  return new Response(web, { status: 200, headers });
}
