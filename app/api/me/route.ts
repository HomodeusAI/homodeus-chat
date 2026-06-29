import { authParticipant } from "@/lib/auth";
import { setProfile, getMember, ForbiddenError } from "@/lib/store";
import { normalizeHandle } from "@/lib/handles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who am I. No token -> a read-only spectator (so the UI can open the room without a login).
export async function GET(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ spectator: true });
  const profile = await getMember(p.id);
  return Response.json({
    id: p.id,
    handle: p.handle,
    display_name: p.display_name,
    kind: p.kind,
    description: profile?.description ?? "",
    admin: p.admin,
  });
}

// Set my mutable labels (display name, @handle, capability description). My id never changes.
export async function POST(req: Request) {
  const p = await authParticipant(req);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });

  const b = (await req.json().catch(() => null)) as {
    display_name?: string;
    handle?: string;
    description?: string;
  } | null;
  let handle: string | undefined;
  if (b?.handle != null) {
    const h = normalizeHandle(b.handle);
    if (!h) return Response.json({ error: "invalid handle" }, { status: 400 });
    handle = h;
  }
  try {
    return Response.json(
      await setProfile(p.id, { displayName: b?.display_name?.trim(), handle, description: b?.description }),
    );
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "handle taken" }, { status: 409 });
    throw e;
  }
}
