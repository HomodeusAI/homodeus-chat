// Shrink the turn budget BEFORE importing anything that reads config (config snapshots env at
// import). Hence the dynamic imports below, same trick as scripts/e2e.ts.
process.env.CHAT_MAX_TURNS = "3";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const { sql } = await import("@/lib/db");
const { hashToken } = await import("@/lib/auth");
const { pendingWakes } = await import("@/lib/store");
const { POST: postMessage } = await import("@/app/api/messages/route");
const readRoom = await import("@/app/api/rooms/[room]/messages/route");
const searchRoom = await import("@/app/api/rooms/[room]/search/route");
const { GET: agentStream } = await import("@/app/api/agent/stream/route");
const { POST: ackWake } = await import("@/app/api/agent/ack/route");
const { POST: depositInsight } = await import("@/app/api/insights/route");
const roomStream = await import("@/app/api/rooms/[room]/stream/route");
const { POST: createSession } = await import("@/app/api/session/route");

// DB-backed: drives the real route handlers (auth, the write path, termination) against Postgres.
// Self-skips when the chat schema isn't reachable, so `pnpm test` stays green without a database.
// Point CHAT_DATABASE_URL at a migrated Postgres to actually run it. Uses a throwaway room.

const ROOM = "httptest";
const ROOM2 = "httptest2"; // exists, but the ROOM agents are NOT members of it
const token: Record<string, string> = {};

async function dbReady(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((res) => {
    timer = setTimeout(() => res(false), 1500);
  });
  try {
    const probe = sql<{ t: string | null }[]>`select to_regclass('chat.wakes')::text as t`.then(
      (rows) => !!rows[0]?.t,
    );
    return await Promise.race([probe, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const hasDb = await dbReady();

async function setup() {
  await sql`delete from rooms where id in (${ROOM}, ${ROOM2})`; // cascade clears any prior run
  await sql`insert into rooms (id, name) values (${ROOM}, 'HTTP') on conflict do nothing`;
  await sql`insert into rooms (id, name) values (${ROOM2}, 'HTTP2') on conflict do nothing`;
  const ps: [string, string, "agent" | "human", string][] = [
    ["p_ht_crm", "htcrm", "agent", "CRM"],
    ["p_ht_beacon", "htbeacon", "agent", "Beacon"],
    ["p_ht_solo", "htsolo", "agent", "Solo"],
    ["p_ht_joao", "htjoao", "human", "Joao"],
  ];
  for (const [id, handle, kind, name] of ps) {
    const t = randomBytes(24).toString("hex");
    token[handle] = t;
    await sql`insert into participants (id, handle, kind, display_name, token_hash)
      values (${id}, ${handle}, ${kind}, ${name}, ${hashToken(t)})
      on conflict (id) do update set token_hash = excluded.token_hash, handle = excluded.handle`;
    await sql`insert into members (room_id, participant_id) values (${ROOM}, ${id})
      on conflict do nothing`;
  }
}

const auth = (handle: string) => ({ authorization: `Bearer ${token[handle]}` });
const jsonHeaders = (handle: string) => ({ ...auth(handle), "content-type": "application/json" });

function post(handle: string, body: unknown): Promise<Response> {
  return postMessage(
    new Request("http://t/api/messages", {
      method: "POST",
      headers: jsonHeaders(handle),
      body: JSON.stringify(body),
    }),
  );
}

const params = (room: string) => ({ params: Promise.resolve({ room }) });

// Read an SSE Response until `want` events arrive (or a safety timeout), then tear the stream down.
// The teardown yields a macrotask first so sse.ts has attached its abort listener, making the
// route's unsubscribe+close actually run (no leaked bus listener across tests).
async function readSse(res: Response, want: number, ac: AbortController, ms = 4000): Promise<any[]> {
  const safety = setTimeout(() => ac.abort(), ms);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const events: any[] = [];
  let buf = "";
  try {
    while (events.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n")) {
          const s = line.trimStart();
          if (s.startsWith("data:")) events.push(JSON.parse(s.slice(5).trim()));
        }
      }
    }
  } finally {
    clearTimeout(safety);
    reader.releaseLock();
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
  }
  return events;
}

before(async () => {
  if (hasDb) await setup();
});

after(async () => {
  if (hasDb) await sql`delete from rooms where id in (${ROOM}, ${ROOM2})`;
  await sql.end();
});

test("401 unauthorized on every guarded route, 403 when a human opens the agent stream", { skip: !hasDb }, async () => {
  const noAuth = (init?: RequestInit) => new Request("http://t/x", init);
  assert.equal((await postMessage(noAuth({ method: "POST", body: "{}" }))).status, 401, "post_message");
  assert.equal((await readRoom.GET(noAuth(), params(ROOM))).status, 401, "read_room");
  assert.equal((await searchRoom.GET(noAuth(), params(ROOM))).status, 401, "search_room");
  assert.equal((await ackWake(noAuth({ method: "POST", body: "{}" }))).status, 401, "ack");
  assert.equal((await agentStream(noAuth())).status, 401, "agent stream");
  assert.equal((await depositInsight(noAuth({ method: "POST", body: "{}" }))).status, 401, "insights");

  const human = await agentStream(new Request("http://t/api/agent/stream", { headers: auth("htjoao") }));
  assert.equal(human.status, 403, "agent stream rejects a human token");
});

test("400 on an empty post body and a non-integer ack seq", { skip: !hasDb }, async () => {
  const empty = await post("htjoao", { room: ROOM, body: "   " });
  assert.equal(empty.status, 400, "blank body rejected");
  const badAck = await ackWake(
    new Request("http://t/api/agent/ack", { method: "POST", headers: jsonHeaders("htcrm"), body: JSON.stringify({ seq: "nope" }) }),
  );
  assert.equal(badAck.status, 400, "non-integer seq rejected");
});

test("post_message authenticates, wakes the mentioned agent, and read/search return it", { skip: !hasDb }, async () => {
  const res = await post("htjoao", { room: ROOM, body: "@htcrm summarize the Acme call" });
  assert.equal(res.status, 200, "authorized post accepted");
  const r = await res.json();
  assert.deepEqual(r.deliverTo, ["p_ht_crm"], "the mentioned agent is woken");
  assert.equal(r.status, "open", "fresh thread is open");
  const seq = r.message.seq;

  const tail = await readRoom.GET(new Request(`http://t/api/rooms/${ROOM}/messages?tail=10`, { headers: auth("htjoao") }), params(ROOM));
  assert.ok((await tail.json()).messages.some((m: any) => m.seq === seq), "tail returns the post");

  const head = await readRoom.GET(new Request(`http://t/api/rooms/${ROOM}/messages?head=1`, { headers: auth("htjoao") }), params(ROOM));
  assert.equal((await head.json()).messages[0].seq, seq, "head=1 returns the seed (first message in the room)");

  const byText = await searchRoom.GET(new Request(`http://t/api/rooms/${ROOM}/search?q=Acme`, { headers: auth("htjoao") }), params(ROOM));
  assert.ok((await byText.json()).messages.some((m: any) => m.seq === seq), "full-text search finds it");

  const byMention = await searchRoom.GET(new Request(`http://t/api/rooms/${ROOM}/search?mentions=p_ht_crm`, { headers: auth("htjoao") }), params(ROOM));
  assert.ok((await byMention.json()).messages.some((m: any) => m.seq === seq), "mention filter finds it");
});

test("agent stream replays a pending wake on connect, and ack clears the cursor", { skip: !hasDb }, async () => {
  const seed = await (await post("htjoao", { room: ROOM, body: "@htsolo ping" })).json();
  const seq = seed.message.seq;

  const ac = new AbortController();
  const res = await agentStream(new Request("http://t/api/agent/stream", { headers: auth("htsolo"), signal: ac.signal }));
  assert.equal(res.status, 200, "agent gets the stream");
  const events = await readSse(res, 2, ac);
  assert.equal(events[0]?.type, "hello", "stream opens with hello");
  assert.ok(events.some((e) => e.type === "wake" && e.message.seq === seq), "the pending wake is replayed");

  const acked = await ackWake(new Request("http://t/api/agent/ack", { method: "POST", headers: jsonHeaders("htsolo"), body: JSON.stringify({ seq }) }));
  assert.equal((await acked.json()).ok, true, "ack accepted");
  assert.ok(!(await pendingWakes("p_ht_solo")).some((m) => m.seq === seq), "wake cleared after ack");
});

test("termination over HTTP: an agent converges, and the circuit breaker halts a runaway", { skip: !hasDb }, async () => {
  const seed = await (await post("htjoao", { room: ROOM, body: "@htcrm one question" })).json();
  const converged = await (
    await post("htcrm", { room: ROOM, body: "Answered. Nothing else needed.", parent_seq: seed.message.seq })
  ).json();
  assert.equal(converged.status, "converged", "agent tagging no one converges the thread");
  assert.deepEqual(converged.deliverTo, [], "convergence wakes no one");

  const loop = await (await post("htjoao", { room: ROOM, body: "@htcrm start a loop" })).json();
  let parent = loop.message.seq;
  const speakers: [string, string][] = [
    ["htcrm", "@htbeacon ping"],
    ["htbeacon", "@htcrm pong"],
    ["htcrm", "@htbeacon ping"],
    ["htbeacon", "@htcrm pong"],
  ];
  let halted: any = null;
  for (const [handle, body] of speakers) {
    const r = await (await post(handle, { room: ROOM, body, parent_seq: parent })).json();
    parent = r.message.seq;
    if (r.status === "halted") {
      halted = r;
      break;
    }
  }
  assert.ok(halted, "the breaker halts the runaway thread past the turn budget");
  assert.deepEqual(halted.deliverTo, [], "a halted post wakes no one");
  assert.equal(halted.haltReason, "max_turns", "halt reason recorded");
  const wk = await sql<{ n: number }[]>`select count(*)::int as n from wakes where message_seq = ${halted.message.seq}`;
  assert.equal(wk[0]?.n, 0, "no durable wake row is written for the halted post");
});

test("insights deposit marks the thread converged", { skip: !hasDb }, async () => {
  const seed = await (await post("htjoao", { room: ROOM, body: "@htcrm what is the close date" })).json();
  const threadId = seed.message.thread_id;
  const bad = await depositInsight(new Request("http://t/api/insights", { method: "POST", headers: jsonHeaders("htcrm"), body: JSON.stringify({ room: ROOM }) }));
  assert.equal(bad.status, 400, "missing fields rejected");

  const ok = await depositInsight(
    new Request("http://t/api/insights", { method: "POST", headers: jsonHeaders("htcrm"), body: JSON.stringify({ room: ROOM, thread_id: threadId, body: "Close date is Q3." }) }),
  );
  assert.equal((await ok.json()).ok, true, "insight accepted");
  const [thread] = await sql<{ status: string }[]>`select status from threads where id = ${threadId}`;
  assert.equal(thread?.status, "converged", "depositing an insight converges the thread");
});

test("membership: a valid token cannot post/read/search/observe a room it is not a member of", { skip: !hasDb }, async () => {
  // htcrm is a member of ROOM but NOT of ROOM2.
  const posted = await post("htcrm", { room: ROOM2, body: "@htbeacon sneak in" });
  assert.equal(posted.status, 403, "post into a non-member room is forbidden");
  const n = await sql<{ n: number }[]>`select count(*)::int as n from messages where room_id = ${ROOM2}`;
  assert.equal(n[0]?.n, 0, "the forbidden post never landed (transaction rolled back)");

  const rd = await readRoom.GET(new Request(`http://t/api/rooms/${ROOM2}/messages?tail=5`, { headers: auth("htcrm") }), params(ROOM2));
  assert.equal(rd.status, 403, "reading a non-member room is forbidden");
  const sr = await searchRoom.GET(new Request(`http://t/api/rooms/${ROOM2}/search?q=x`, { headers: auth("htcrm") }), params(ROOM2));
  assert.equal(sr.status, 403, "searching a non-member room is forbidden");

  const cookie = (handle: string) => ({ cookie: `chat_token=${token[handle]}` });
  const observe = await roomStream.GET(new Request(`http://t/api/rooms/${ROOM2}/stream`, { headers: cookie("htcrm") }), params(ROOM2));
  assert.equal(observe.status, 403, "observing a non-member room is forbidden");
  const anon = await roomStream.GET(new Request(`http://t/api/rooms/${ROOM2}/stream`), params(ROOM2));
  assert.equal(anon.status, 401, "observing without a credential is unauthorized (no more open stream)");

  // positive: a member observes their own room via the session cookie (no token in the URL)
  const ac = new AbortController();
  const okObserve = await roomStream.GET(
    new Request(`http://t/api/rooms/${ROOM}/stream`, { headers: cookie("htcrm"), signal: ac.signal }),
    params(ROOM),
  );
  assert.equal(okObserve.status, 200, "a member observes via the httpOnly session cookie");
  ac.abort();
});

test("POST /api/session issues an httpOnly cookie for a valid token, 401 for a bad one", { skip: !hasDb }, async () => {
  const sess = (t: string) =>
    createSession(new Request("http://t/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t }) }));
  const good = await sess(token["htcrm"]!);
  assert.equal(good.status, 200, "valid token accepted");
  assert.match(good.headers.get("set-cookie") ?? "", /chat_token=.+HttpOnly/i, "sets an httpOnly cookie");
  const bad = await sess("not-a-real-token");
  assert.equal(bad.status, 401, "invalid token rejected");
});
