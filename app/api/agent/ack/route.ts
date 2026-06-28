import { authParticipant } from "@/lib/auth";
import { ackWake } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The adapter acks a wake once the gateway has it durably. Advances the agent's delivery cursor.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { seq?: number | string } | null;
  const seq = Number(body?.seq);
  if (!Number.isInteger(seq)) {
    return Response.json({ error: "integer seq required" }, { status: 400 });
  }
  await ackWake(p.id, seq);
  return Response.json({ ok: true });
}
