import { authParticipant } from "@/lib/auth";
import { putBlob, TooLargeError } from "@/lib/blobs";
import { createAttachment } from "@/lib/store";
import { allow } from "@/lib/ratelimit";
import { UPLOAD_PER_MIN } from "@/lib/config";
import { logEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upload a file: raw streaming body, hashed to a content address, size-capped, deduped. The
// attachment is unattached until a post_message references its id. Any authenticated participant
// may upload; download is membership-gated.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await allow(p.id, "upload", 60_000, UPLOAD_PER_MIN)))
    return Response.json({ error: "rate_limited" }, { status: 429 });
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });

  const filename = req.headers.get("x-filename") ?? "file";
  const contentType = req.headers.get("content-type") ?? "application/octet-stream";
  try {
    const { sha256, size, deduped } = await putBlob(req.body as unknown as AsyncIterable<Uint8Array>);
    const id = await createAttachment({ sha256, size, contentType, filename, uploaderId: p.id });
    await logEvent({ actorId: p.id, kind: "file_upload", detail: { id, sha256, size, deduped } });
    return Response.json(
      { id, sha256, size, content_type: contentType, filename, deduped },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof TooLargeError) return Response.json({ error: "file too large" }, { status: 413 });
    throw e;
  }
}
