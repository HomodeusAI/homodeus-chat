import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDelivery, FRESH_LEDGER, type Ledger, type Budget } from "../lib/threads";

const B: Budget = { maxTurns: 3 };
const open = (over: Partial<Ledger> = {}): Ledger => ({ ...FRESH_LEDGER, ...over });

test("human post reopens the thread and delivers to mentioned agents", () => {
  const prev = open({ turnCount: 99, status: "halted" });
  const d = decideDelivery(prev, { authorKind: "human", mentionedAgentIds: ["a"] }, B);
  assert.equal(d.ledger.turnCount, 0);
  assert.equal(d.ledger.status, "open");
  assert.deepEqual(d.deliverTo, ["a"]);
});

test("agent tagging nobody converges the branch and wakes no one (the agent chose to stop)", () => {
  const d = decideDelivery(open({ turnCount: 2 }), { authorKind: "agent", mentionedAgentIds: [] }, B);
  assert.equal(d.ledger.status, "converged");
  assert.deepEqual(d.deliverTo, []);
});

test("agent->agent turn increments the fuse and delivers", () => {
  const d = decideDelivery(open({ turnCount: 1 }), { authorKind: "agent", mentionedAgentIds: ["b"] }, B);
  assert.equal(d.ledger.turnCount, 2);
  assert.equal(d.ledger.status, "open");
  assert.deepEqual(d.deliverTo, ["b"]);
});

test("turn fuse halts a runaway loop past the cap and delivers nothing", () => {
  const d = decideDelivery(open({ turnCount: 3 }), { authorKind: "agent", mentionedAgentIds: ["b"] }, B);
  assert.equal(d.ledger.status, "halted");
  assert.equal(d.haltReason, "max_turns");
  assert.deepEqual(d.deliverTo, []);
});

test("maxTurns = 0 disables the fuse: agents loop without ever being halted", () => {
  const d = decideDelivery(open({ turnCount: 9999 }), { authorKind: "agent", mentionedAgentIds: ["b"] }, { maxTurns: 0 });
  assert.equal(d.ledger.status, "open");
  assert.deepEqual(d.deliverTo, ["b"]);
});

test("a halted thread never auto-resumes from an agent post", () => {
  const d = decideDelivery(open({ status: "halted" }), { authorKind: "agent", mentionedAgentIds: ["b"] }, B);
  assert.equal(d.ledger.status, "halted");
  assert.deepEqual(d.deliverTo, []);
  assert.equal(d.haltReason, "already_halted");
});
