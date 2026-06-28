import { authParticipant } from "@/lib/auth";
import { pendingWakes, getMessage } from "@/lib/store";
import { subscribeWake } from "@/lib/bus";
import { sseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Agent wake stream. The Hermes plugin adapter consumes this and acks each wake after handing it to
// the gateway. Subscribe-before-replay: we register the live listener FIRST (buffering events), then
// read the durable backlog, then flush the buffer — deduping by seq. This closes the race where a
// wake committed-and-published between a "replay then subscribe" ordering would land in neither set
// and silently never reach a mentioned agent (the system's headline guarantee).
export async function GET(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (p.kind !== "agent") return Response.json({ error: "agents only" }, { status: 403 });

  return sseResponse(req, async (send) => {
    send({ type: "hello", participant: p.id, handle: p.handle });

    const sent = new Set<number>();
    const emit = (m: { seq: number }) => {
      if (sent.has(m.seq)) return;
      sent.add(m.seq);
      send({ type: "wake", message: m });
    };

    const buffered: number[] = [];
    let replaying = true;
    const unsub = subscribeWake(p.id, async (ev) => {
      if (replaying) {
        buffered.push(ev.messageSeq);
        return;
      }
      const m = await getMessage(ev.messageSeq);
      if (m) emit(m);
    });

    for (const m of await pendingWakes(p.id)) emit(m);
    replaying = false;
    for (const seq of buffered) {
      if (sent.has(seq)) continue;
      const m = await getMessage(seq);
      if (m) emit(m);
    }

    return unsub;
  });
}
