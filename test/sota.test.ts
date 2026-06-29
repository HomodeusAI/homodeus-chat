// Keep posts/registers un-throttled for the functional tests; rate limiting is unit-tested directly.
process.env.CHAT_POST_PER_MIN = "500";
process.env.CHAT_REGISTER_PER_HOUR = "500";
process.env.CHAT_UPLOAD_PER_MIN = "500";
process.env.CHAT_JOIN_PER_MIN = "500";
process.env.CHAT_BLOB_ROOT = "/tmp/homodeus-chat-test-blobs";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { sql } = await import("@/lib/db");
const { allow } = await import("@/lib/ratelimit");
const { POST: register } = await import("@/app/api/register/route");
const rooms = await import("@/app/api/rooms/route");
const join = await import("@/app/api/rooms/[room]/join/route");
const leave = await import("@/app/api/rooms/[room]/leave/route");
const { POST: postMessage } = await import("@/app/api/messages/route");
const readRoom = await import("@/app/api/rooms/[room]/messages/route");
const { POST: uploadFile } = await import("@/app/api/attachments/route");
const downloadFile = await import("@/app/api/attachments/[id]/route");

async function dbReady(): Promise<boolean> {
  try {
    const r = await Promise.race([
      sql<{ t: string | null }[]>`select to_regclass('chat.attachments')::text as t`.then((x) => !!x[0]?.t),
      new Promise<false>((res) => setTimeout(() => res(false), 1500)),
    ]);
    return r;
  } catch {
    return false;
  }
}
const hasDb = await dbReady();

const jsonReq = (path: string, token: string | null, body: unknown, method = "POST") =>
  new Request("http://t" + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const params = (room: string) => ({ params: Promise.resolve({ room }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function reg(handle: string): Promise<{ id: string; token: string }> {
  const res = await register(jsonReq("/api/register", null, { handle, display_name: handle }));
  return res.json();
}

const tag = "s" + Math.floor(Date.now() / 1000) % 100000;
let creator: { id: string; token: string };
let member: { id: string; token: string };
let outsider: { id: string; token: string };

before(async () => {
  if (!hasDb) return;
  creator = await reg(tag + "a");
  member = await reg(tag + "b");
  outsider = await reg(tag + "c");
});
after(async () => {
  try {
    if (hasDb && creator) {
      const ids = [creator.id, member.id, outsider.id];
      await sql`delete from rooms where created_by in ${sql(ids)}`; // cascades messages/mentions/wakes/links
      await sql`delete from attachments where uploader_id in ${sql(ids)}`;
      await sql`delete from participants where id in ${sql(ids)}`;
    }
  } finally {
    await sql.end(); // always close the pool so the test process exits
  }
});

test("register forces kind=agent, rejects bad handles and duplicates", { skip: !hasDb }, async () => {
  const [p] = await sql<{ kind: string; created_via: string }[]>`select kind, created_via from participants where id = ${creator.id}`;
  assert.equal(p?.kind, "agent", "self-registration is always an agent, never an operator");
  assert.equal(p?.created_via, "self");
  assert.equal((await register(jsonReq("/api/register", null, { handle: "Bad Handle!", display_name: "x" }))).status, 400);
  assert.equal((await register(jsonReq("/api/register", null, { handle: "admin", display_name: "x" }))).status, 400, "reserved handle blocked");
  assert.equal((await register(jsonReq("/api/register", null, { handle: tag + "a", display_name: "dup" }))).status, 409, "duplicate handle");
});

test("rooms: create, discover, self-join open, reject invite, 404 missing", { skip: !hasDb }, async () => {
  const open = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  const invite = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Invite", open: false }))).json();

  const listed = await (await rooms.GET(new Request("http://t/api/rooms", { headers: { authorization: `Bearer ${member.token}` } }))).json();
  const ids = listed.rooms.map((r: { id: string }) => r.id);
  assert.ok(ids.includes(open.id), "open room is discoverable by a non-member");
  assert.ok(!ids.includes(invite.id), "invite-only room is hidden from non-members");

  assert.equal((await join.POST(jsonReq(`/api/rooms/${open.id}/join`, member.token, {}), params(open.id))).status, 200, "join open room");
  assert.equal((await join.POST(jsonReq(`/api/rooms/${invite.id}/join`, member.token, {}), params(invite.id))).status, 403, "join invite room denied");
  assert.equal((await join.POST(jsonReq(`/api/rooms/nope-xxxx/join`, member.token, {}), params("nope-xxxx"))).status, 404, "join missing room");
  assert.equal((await leave.POST(jsonReq(`/api/rooms/${open.id}/leave`, member.token, {}), params(open.id))).status, 200, "leave");
});

test("files: upload, attach, read-enrich, member download matches, non-member 403, dedupe", { skip: !hasDb }, async () => {
  const room = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  await join.POST(jsonReq(`/api/rooms/${room.id}/join`, member.token, {}), params(room.id));

  const content = "the quick brown fox " + tag;
  const up = await (
    await uploadFile(
      new Request("http://t/api/attachments", {
        method: "POST",
        headers: { authorization: `Bearer ${creator.token}`, "content-type": "text/plain", "x-filename": "fox.txt" },
        body: content,
      }),
    )
  ).json();
  assert.ok(up.id && up.sha256, "upload returns id + sha256");

  const posted = await (await postMessage(jsonReq("/api/messages", creator.token, { room: room.id, body: "see file", attachment_ids: [up.id] }))).json();
  assert.deepEqual(posted.message.attachments?.[0]?.id, up.id, "posted message carries the attachment");

  const read = await (await readRoom.GET(new Request(`http://t/api/rooms/${room.id}/messages?tail=5`, { headers: { authorization: `Bearer ${member.token}` } }), params(room.id))).json();
  assert.ok(read.messages.at(-1).attachments.some((a: { id: number }) => a.id === up.id), "read enriches attachments");

  const dl = await downloadFile.GET(new Request(`http://t/api/attachments/${up.id}`, { headers: { authorization: `Bearer ${member.token}` } }), idParams(String(up.id)));
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), content, "member downloads the exact bytes");

  const denied = await downloadFile.GET(new Request(`http://t/api/attachments/${up.id}`, { headers: { authorization: `Bearer ${outsider.token}` } }), idParams(String(up.id)));
  assert.equal(denied.status, 403, "a non-member of any sharing room cannot download");

  const up2 = await (
    await uploadFile(new Request("http://t/api/attachments", { method: "POST", headers: { authorization: `Bearer ${creator.token}`, "content-type": "text/plain", "x-filename": "fox2.txt" }, body: content }))
  ).json();
  assert.equal(up2.sha256, up.sha256, "identical bytes share a content address");
  assert.equal(up2.deduped, true, "re-upload is deduped on disk");
});

test("attachment ownership: cannot attach a file you did not upload", { skip: !hasDb }, async () => {
  const room = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  const up = await (
    await uploadFile(new Request("http://t/api/attachments", { method: "POST", headers: { authorization: `Bearer ${creator.token}`, "content-type": "text/plain", "x-filename": "c.txt" }, body: "creator's file" }))
  ).json();
  // outsider tries to attach creator's upload
  await join.POST(jsonReq(`/api/rooms/${room.id}/join`, outsider.token, {}), params(room.id));
  const res = await postMessage(jsonReq("/api/messages", outsider.token, { room: room.id, body: "stealing", attachment_ids: [up.id] }));
  assert.equal(res.status, 403, "attaching another participant's file is forbidden");
});

test("idempotency: a repeated key replays the same message and wakes no one twice", { skip: !hasDb }, async () => {
  const room = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  const body = { room: room.id, body: "do it once", idempotency_key: "k-" + tag };
  const r1 = await (await postMessage(jsonReq("/api/messages", creator.token, body))).json();
  const r2 = await (await postMessage(jsonReq("/api/messages", creator.token, body))).json();
  assert.equal(r2.message.seq, r1.message.seq, "same seq returned");
  assert.equal(r2.replayed, true, "second call is a replay");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from messages where room_id = ${room.id} and body = 'do it once'`;
  assert.equal(n, 1, "only one row was inserted");
});

test("cost cap: a post over the author's daily cap is rejected", { skip: !hasDb }, async () => {
  const room = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  await sql`update participants set daily_cost_cap = 0.5 where id = ${creator.id}`;
  const ok = await postMessage(jsonReq("/api/messages", creator.token, { room: room.id, body: "cheap", cost_usd: 0.4 }));
  assert.equal(ok.status, 200, "under the cap is fine");
  const over = await postMessage(jsonReq("/api/messages", creator.token, { room: room.id, body: "pricey", cost_usd: 0.4 }));
  assert.equal(over.status, 429, "cumulative spend over the cap is blocked");
  await sql`update participants set daily_cost_cap = 0 where id = ${creator.id}`;
});

test("rate limiter: allows up to the limit per window, then drops", { skip: !hasDb }, async () => {
  const subj = "unit:" + tag;
  assert.equal(await allow(subj, "t", 60_000, 2), true);
  assert.equal(await allow(subj, "t", 60_000, 2), true);
  assert.equal(await allow(subj, "t", 60_000, 2), false, "third in the window is dropped");
});

test("download forces non-inline types to an octet-stream attachment with nosniff (no stored XSS)", { skip: !hasDb }, async () => {
  const up = await (
    await uploadFile(new Request("http://t/api/attachments", { method: "POST", headers: { authorization: `Bearer ${creator.token}`, "content-type": "text/html", "x-filename": "evil.html" }, body: "<script>alert(1)</script>" }))
  ).json();
  const dl = await downloadFile.GET(new Request(`http://t/api/attachments/${up.id}`, { headers: { authorization: `Bearer ${creator.token}` } }), idParams(String(up.id)));
  assert.equal(dl.headers.get("content-type"), "application/octet-stream", "html is not served with its own type");
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/, "served as a download, never inline");
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
});

test("parent_seq is room-scoped: a cross-room parent starts a fresh thread, not the foreign one", { skip: !hasDb }, async () => {
  const a = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  const b = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  const seedB = await (await postMessage(jsonReq("/api/messages", creator.token, { room: b.id, body: "seed in B" }))).json();
  const inA = await (await postMessage(jsonReq("/api/messages", creator.token, { room: a.id, body: "tries to ride B", parent_seq: seedB.message.seq }))).json();
  assert.equal(inA.message.thread_id, inA.message.seq, "the cross-room parent is ignored; the post is a new seed in A");
  assert.notEqual(inA.message.thread_id, seedB.message.thread_id, "it did not adopt room B's thread");
});

test("concurrent posts with the same idempotency key insert exactly one message", { skip: !hasDb }, async () => {
  const room = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  const body = { room: room.id, body: "race", idempotency_key: "race-" + tag };
  const [r1, r2] = await Promise.all([
    postMessage(jsonReq("/api/messages", creator.token, body)).then((r) => r.json()),
    postMessage(jsonReq("/api/messages", creator.token, body)).then((r) => r.json()),
  ]);
  assert.equal(r1.message.seq, r2.message.seq, "both racers resolve to the same message");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from messages where room_id = ${room.id} and body = 'race'`;
  assert.equal(n, 1, "exactly one message row inserted despite the race");
});

test("post rejects non-integer parent_seq / attachment_ids", { skip: !hasDb }, async () => {
  const room = await (await rooms.POST(jsonReq("/api/rooms", creator.token, { name: "Open", open: true }))).json();
  assert.equal((await postMessage(jsonReq("/api/messages", creator.token, { room: room.id, body: "x", parent_seq: "nope" }))).status, 400);
  assert.equal((await postMessage(jsonReq("/api/messages", creator.token, { room: room.id, body: "x", attachment_ids: ["a"] }))).status, 400);
});
