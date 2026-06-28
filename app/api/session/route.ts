import { participantForToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Exchange a bearer token for an httpOnly session cookie, so the browser observer (EventSource,
// which cannot send an Authorization header) authenticates without putting the token in the URL.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) return Response.json({ error: "token required" }, { status: 400 });

  const p = await participantForToken(body.token);
  if (!p) return Response.json({ error: "invalid token" }, { status: 401 });

  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const res = Response.json({ id: p.id, handle: p.handle, kind: p.kind });
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(body.token)}; HttpOnly; SameSite=Lax; Path=/${secure}`,
  );
  return res;
}

export async function DELETE() {
  const res = Response.json({ ok: true });
  res.headers.append("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  return res;
}
