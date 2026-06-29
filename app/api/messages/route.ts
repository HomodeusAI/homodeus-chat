import { authParticipant } from "@/lib/auth";
import { postMessage, ForbiddenError } from "@/lib/store";
import { publishRoom, publishWake } from "@/lib/bus";
import { allow } from "@/lib/ratelimit";
import { POST_PER_MIN } from "@/lib/config";
import { logEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// post_message: the one write path. Any member posts here, with @mentions, file attachments, an
// optional parent (threading), and an optional idempotency key for safe retries.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!(await allow(p.id, "post", 60_000, POST_PER_MIN)))
    return Response.json({ error: "rate_limited" }, { status: 429 });

  const body = (await req.json().catch(() => null)) as {
    room?: string;
    body?: string;
    parent_seq?: number | null;
    attachment_ids?: number[];
    idempotency_key?: string;
  } | null;

  const text = typeof body?.body === "string" ? body.body : "";
  const hasFiles = Array.isArray(body?.attachment_ids) && body.attachment_ids.length > 0;
  if (!body?.room || (!text.trim() && !hasFiles)) {
    return Response.json({ error: "room and (non-empty body or attachments) required" }, { status: 400 });
  }
  if (body.parent_seq != null && !Number.isInteger(body.parent_seq)) {
    return Response.json({ error: "parent_seq must be an integer" }, { status: 400 });
  }
  if (body.attachment_ids !== undefined &&
      (!Array.isArray(body.attachment_ids) || body.attachment_ids.some((x) => !Number.isInteger(x)))) {
    return Response.json({ error: "attachment_ids must be an array of integers" }, { status: 400 });
  }

  try {
    const result = await postMessage({
      authorId: p.id,
      authorKind: p.kind,
      roomId: body.room,
      body: text,
      parentSeq: body.parent_seq ?? null,
      attachmentIds: body.attachment_ids,
      idempotencyKey: body.idempotency_key,
    });

    result.message.author_handle = p.handle; // so readers (and the live stream) know who spoke inline
    result.message.author_name = p.display_name;
    if (!result.replayed) {
      publishRoom(body.room, { type: "message", message: result.message });
      for (const agentId of result.deliverTo) {
        publishWake(agentId, { type: "wake", messageSeq: result.message.seq });
      }
      if (result.haltReason)
        await logEvent({ actorId: p.id, roomId: body.room, kind: "halt", detail: { reason: result.haltReason } });
    }
    return Response.json(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403 });
    throw e;
  }
}
