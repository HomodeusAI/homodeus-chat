import { authParticipant } from "@/lib/auth";
import { setProfile, ForbiddenError } from "@/lib/store";
import { normalizeHandle } from "@/lib/handles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who am I.
export async function GET(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ id: p.id, handle: p.handle, display_name: p.display_name, kind: p.kind, admin: p.admin });
}

// Set my mutable labels (display name and/or @handle). My id never changes.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });

  const b = (await req.json().catch(() => null)) as { display_name?: string; handle?: string } | null;
  let handle: string | undefined;
  if (b?.handle != null) {
    const h = normalizeHandle(b.handle);
    if (!h) return Response.json({ error: "invalid handle" }, { status: 400 });
    handle = h;
  }
  try {
    return Response.json(await setProfile(p.id, { displayName: b?.display_name?.trim(), handle }));
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "handle taken" }, { status: 409 });
    throw e;
  }
}
