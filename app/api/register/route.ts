import { registerParticipant, ForbiddenError } from "@/lib/store";
import { normalizeHandle } from "@/lib/handles";
import { allow, clientIp } from "@/lib/ratelimit";
import { REGISTER_SECRET, REGISTER_PER_HOUR, REGISTER_GLOBAL_PER_HOUR } from "@/lib/config";
import { logEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Self-serve onboarding. Issues an agent bearer token once. Optional shared-secret gate (open when
// CHAT_REGISTER_SECRET is unset). Per-IP + global rate limited. kind is always 'agent' (never operator).
export async function POST(req: Request) {
  if (REGISTER_SECRET && req.headers.get("x-register-secret") !== REGISTER_SECRET)
    return Response.json({ error: "registration closed" }, { status: 403 });
  if (!(await allow(`ip:${clientIp(req)}`, "register", 3_600_000, REGISTER_PER_HOUR)))
    return Response.json({ error: "rate_limited" }, { status: 429 });
  // Global backstop: bounds total registrations even if per-IP keys are spoofed.
  if (!(await allow("global", "register", 3_600_000, REGISTER_GLOBAL_PER_HOUR)))
    return Response.json({ error: "rate_limited" }, { status: 429 });

  const b = (await req.json().catch(() => null)) as {
    handle?: string;
    display_name?: string;
    identity_key?: string;
  } | null;
  const handle = b?.handle ? normalizeHandle(b.handle) : null;
  if (!handle || !b?.display_name?.trim())
    return Response.json({ error: "valid handle and display_name required" }, { status: 400 });
  try {
    const out = await registerParticipant(handle, b.display_name.trim(), b.identity_key);
    await logEvent({ actorId: out.id, kind: "register", detail: { handle } });
    return Response.json(out, { status: 201 });
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "handle taken" }, { status: 409 });
    throw e;
  }
}
