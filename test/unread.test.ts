import { test, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "../lib/db";
import { postMessage, ackWake, listUnread } from "../lib/store";

// DB-backed: drives the real write path so the grouping is the production SQL, not a fixture.
// Self-skips when the chat schema isn't reachable, so `pnpm test` stays green without a database.
// Point CHAT_DATABASE_URL at a migrated Postgres to actually run it. Uses throwaway rooms.

const R1 = "unread_r1";
const R2 = "unread_r2";
const AGENT = "p_unread_agent";
const HUMAN = "p_unread_human";

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
  for (const id of [R1, R2]) {
    await sql`delete from rooms where id = ${id}`; // cascade clears any prior run
    await sql`insert into rooms (id, name) values (${id}, ${id}) on conflict do nothing`;
  }
  const ps: [string, string, "agent" | "human", string][] = [
    [AGENT, "unreadagent", "agent", "Agent"],
    [HUMAN, "unreadhuman", "human", "Human"],
  ];
  for (const [id, handle, kind, name] of ps) {
    await sql`insert into participants (id, handle, kind, display_name)
      values (${id}, ${handle}, ${kind}, ${name})
      on conflict (id) do update set handle = excluded.handle`;
    for (const room of [R1, R2]) {
      await sql`insert into members (room_id, participant_id) values (${room}, ${id})
        on conflict do nothing`;
    }
  }
}

const mention = (room: string) =>
  postMessage({ authorId: HUMAN, authorKind: "human", roomId: room, body: "@unreadagent ping" });

after(async () => {
  if (hasDb) for (const id of [R1, R2]) await sql`delete from rooms where id = ${id}`;
  await sql.end();
});

test("list_unread groups unacked wakes by room with counts; ack clears them", { skip: !hasDb }, async () => {
  await setup();
  const a = await mention(R1);
  const b = await mention(R1);
  await mention(R2);

  const counts = (await listUnread(AGENT)).reduce(
    (acc, r) => ({ ...acc, [r.room_id]: r.count }),
    {} as Record<string, number>,
  );
  assert.equal(counts[R1], 2, "two unacked wakes in r1");
  assert.equal(counts[R2], 1, "one unacked wake in r2");

  await ackWake(AGENT, a.message.seq);
  const afterOne = await listUnread(AGENT);
  assert.equal(afterOne.find((r) => r.room_id === R1)?.count, 1, "r1 drops to 1 after one ack");

  await ackWake(AGENT, b.message.seq);
  const afterBoth = await listUnread(AGENT);
  assert.equal(afterBoth.find((r) => r.room_id === R1), undefined, "r1 absent once fully acked");
  assert.equal(afterBoth.find((r) => r.room_id === R2)?.count, 1, "r2 still pending");
});
