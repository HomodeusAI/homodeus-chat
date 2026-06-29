// End-to-end against real Postgres, driving the store directly (the HTTP layer is a thin shell
// over these calls). Verifies: threading, mention->wake, durable wake queue + ack, agent->agent
// convergence, and the circuit breaker. Uses a throwaway room and cleans up after itself.
//
// Budget is shrunk via env BEFORE importing the store (config reads env at import), so the breaker
// trips quickly. Hence the dynamic import below.

export {}; // make this a module so top-level await is allowed

process.env.CHAT_MAX_TURNS = "3";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
};

const { sql } = await import("../lib/db");
const { postMessage, readRoom, pendingWakes, ackWake } = await import("../lib/store");

const ROOM = "e2e";

async function setup() {
  await sql`delete from rooms where id = ${ROOM}`; // cascade clears prior run
  await sql`insert into rooms (id, name) values (${ROOM}, 'E2E') on conflict do nothing`;
  const ps: [string, string, "agent" | "human", string][] = [
    ["p_e2e_crm", "e2ecrm", "agent", "CRM"],
    ["p_e2e_beacon", "e2ebeacon", "agent", "Beacon"],
    ["p_e2e_joao", "e2ejoao", "human", "Joao"],
  ];
  for (const [id, handle, kind, name] of ps) {
    await sql`insert into participants (id, handle, kind, display_name)
      values (${id}, ${handle}, ${kind}, ${name})
      on conflict (id) do update set handle = excluded.handle`;
    await sql`insert into members (room_id, participant_id) values (${ROOM}, ${id})
      on conflict do nothing`;
  }
}

async function run() {
  await setup();
  console.log("1) human seeds a thread, tagging the CRM agent");
  const seed = await postMessage({
    authorId: "p_e2e_joao", authorKind: "human", roomId: ROOM,
    body: "@e2ecrm summarize the Acme call",
  });
  assert(seed.deliverTo.length === 1 && seed.deliverTo[0] === "p_e2e_crm", "CRM is woken");
  assert(seed.message.thread_id === seed.message.seq, "seed thread points at itself");
  assert(seed.status === "open", "thread open");

  console.log("2) the wake is durably queued, then acked");
  let pend = await pendingWakes("p_e2e_crm");
  assert(pend.some((m) => m.seq === seed.message.seq), "CRM has a pending wake");
  await ackWake("p_e2e_crm", seed.message.seq);
  pend = await pendingWakes("p_e2e_crm");
  assert(!pend.some((m) => m.seq === seed.message.seq), "wake cleared after ack");

  console.log("3) CRM replies in-thread, tagging Beacon");
  const r1 = await postMessage({
    authorId: "p_e2e_crm", authorKind: "agent", roomId: ROOM,
    body: "Acme is stage-3. @e2ebeacon what's the close date?",
    parentSeq: seed.message.seq,
  });
  assert(r1.deliverTo.length === 1 && r1.deliverTo[0] === "p_e2e_beacon", "Beacon is woken");
  assert(r1.message.thread_id === seed.message.seq, "reply stays in the same thread");
  assert(r1.message.depth === 1, "depth incremented");

  console.log("4) Beacon converges (mentions no one) -> thread goes dormant");
  const r2 = await postMessage({
    authorId: "p_e2e_beacon", authorKind: "agent", roomId: ROOM,
    body: "Close date is Q3. Nothing else needed.",
    parentSeq: r1.message.seq,
  });
  assert(r2.deliverTo.length === 0, "no one woken on convergence");
  assert(r2.status === "converged", "thread marked converged");

  console.log("5) circuit breaker: force an agent<->agent loop past the turn budget (3)");
  const loopSeed = await postMessage({
    authorId: "p_e2e_joao", authorKind: "human", roomId: ROOM, body: "@e2ecrm start a loop",
  });
  let parent = loopSeed.message.seq;
  const speakers: ["p_e2e_crm" | "p_e2e_beacon", string][] = [
    ["p_e2e_crm", "@e2ebeacon ping"],
    ["p_e2e_beacon", "@e2ecrm pong"],
    ["p_e2e_crm", "@e2ebeacon ping"],
    ["p_e2e_beacon", "@e2ecrm pong"],
    ["p_e2e_crm", "@e2ebeacon ping"],
  ];
  let halted = false;
  for (const [who, body] of speakers) {
    const r = await postMessage({ authorId: who, authorKind: "agent", roomId: ROOM, body, parentSeq: parent });
    parent = r.message.seq;
    if (r.status === "halted") { halted = true; assert(r.deliverTo.length === 0, "halt delivers no wake"); break; }
  }
  assert(halted, "circuit breaker halted the runaway thread");

  console.log("6) read slices");
  const tail = await readRoom(ROOM, { tail: 3 });
  assert(tail.length === 3, "tail=3 returns 3");
  const head = await readRoom(ROOM, { head: 1 });
  assert(head[0]!.seq === seed.message.seq, "head=1 returns the first message");

  await sql`delete from rooms where id = ${ROOM}`;
  await sql.end();
  console.log("\nE2E PASSED");
}

run().catch(async (e) => {
  console.error("\n" + String(e));
  try { await sql.end(); } catch {}
  process.exit(1);
});
