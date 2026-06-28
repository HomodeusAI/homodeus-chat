import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDelivery, FRESH_LEDGER, type Ledger, type Budget } from "../lib/threads";

const B: Budget = { maxTurns: 3, maxTokens: 1000, maxCostUsd: 1 };
const open = (over: Partial<Ledger> = {}): Ledger => ({ ...FRESH_LEDGER, ...over });

test("human post resets the ledger and delivers to mentioned agents", () => {
  const prev = open({ turnCount: 99, status: "halted" });
  const d = decideDelivery(prev, { authorKind: "human", mentionedAgentIds: ["a"] }, B);
  assert.equal(d.ledger.turnCount, 0);
  assert.equal(d.ledger.status, "open");
  assert.deepEqual(d.deliverTo, ["a"]);
});

test("agent tagging nobody converges the branch and wakes no one", () => {
  const d = decideDelivery(open({ turnCount: 2 }), { authorKind: "agent", mentionedAgentIds: [] }, B);
  assert.equal(d.ledger.status, "converged");
  assert.deepEqual(d.deliverTo, []);
});

test("agent->agent turn consumes budget and delivers", () => {
  const d = decideDelivery(open({ turnCount: 1 }), { authorKind: "agent", mentionedAgentIds: ["b"] }, B);
  assert.equal(d.ledger.turnCount, 2);
  assert.equal(d.ledger.status, "open");
  assert.deepEqual(d.deliverTo, ["b"]);
});

test("circuit breaker halts on max turns and delivers nothing", () => {
  const d = decideDelivery(open({ turnCount: 3 }), { authorKind: "agent", mentionedAgentIds: ["b"] }, B);
  assert.equal(d.ledger.status, "halted");
  assert.equal(d.haltReason, "max_turns");
  assert.deepEqual(d.deliverTo, []);
});

test("circuit breaker halts on token ceiling", () => {
  const d = decideDelivery(
    open({ turnCount: 0, tokenCount: 900 }),
    { authorKind: "agent", mentionedAgentIds: ["b"], tokens: 200 },
    B,
  );
  assert.equal(d.ledger.status, "halted");
  assert.equal(d.haltReason, "max_tokens");
});

test("a halted thread never auto-resumes from an agent post", () => {
  const d = decideDelivery(open({ status: "halted" }), { authorKind: "agent", mentionedAgentIds: ["b"] }, B);
  assert.equal(d.ledger.status, "halted");
  assert.deepEqual(d.deliverTo, []);
  assert.equal(d.haltReason, "already_halted");
});
