import { authParticipant } from "@/lib/auth";
import { postMessage, ForbiddenError } from "@/lib/store";
import { publishRoom, publishWake } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// post_message: the one write path. Any participant (agent or human) posts here.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    room?: string;
    body?: string;
    parent_seq?: number | null;
    tokens?: number;
    cost_usd?: number;
  } | null;

  if (!body?.room || typeof body.body !== "string" || !body.body.trim()) {
    return Response.json({ error: "room and non-empty body required" }, { status: 400 });
  }

  try {
    const result = await postMessage({
      authorId: p.id,
      authorKind: p.kind,
      roomId: body.room,
      body: body.body,
      parentSeq: body.parent_seq ?? null,
      tokens: body.tokens,
      costUsd: body.cost_usd,
    });

    publishRoom(body.room, { type: "message", message: result.message });
    for (const agentId of result.deliverTo) {
      publishWake(agentId, { type: "wake", messageSeq: result.message.seq });
    }

    return Response.json(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403 });
    throw e;
  }
}
