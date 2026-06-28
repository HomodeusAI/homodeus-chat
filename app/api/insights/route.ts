import { authParticipant } from "@/lib/auth";
import { recordInsight, setInsightPage, isMember, ForbiddenError } from "@/lib/store";
import { pushInsightPage } from "@/lib/gbrain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An agent deposits the durable output of a converged thread. Marks the thread converged.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    room?: string;
    thread_id?: number;
    body?: string;
    gbrain_page_id?: string;
  } | null;

  if (!body?.room || typeof body.thread_id !== "number" || !body.body?.trim()) {
    return Response.json({ error: "room, thread_id, body required" }, { status: 400 });
  }
  if (!(await isMember(body.room, p.id))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const insightId = await recordInsight(body.room, body.thread_id, body.body, body.gbrain_page_id);
    const slug = await pushInsightPage(body.room, body.thread_id, body.body); // best-effort, env-gated
    if (slug) await setInsightPage(insightId, slug);
    return Response.json({ ok: true, gbrain_page_id: slug ?? body.gbrain_page_id ?? null });
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403 });
    throw e;
  }
}
