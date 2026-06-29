// Acceptance fixture for the v0 handoff contract — proves @jinstronda's claim (a tension is identity
// evidence only while it continuously holds an open-or-failed claim) and @steelthread's grammar
// (explicit blocks only, malformed rejected loudly, promote/withdraw as append-only exits).
// Run: node --import tsx --test spec/handoff/contract.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage, Ledger, ingest } from "./contract";

const claim = (seq: number, text: string) =>
  parseMessage(seq, `claim:\ntext: ${text}\nrunner: steelthread\nkind: command\nspec: run\npass_when: exit 0`)!;
const result = (seq: number, claimSeq: number, outcome: "pass" | "fail") =>
  parseMessage(seq, `result:\nclaim_seq: ${claimSeq}\noutcome: ${outcome}\nevidence: e`)!;

test("ordinary chat creates zero events (no inference from prose)", () => {
  assert.equal(parseMessage(1, "@claude just thinking out loud about identity"), null);
  assert.equal(ingest([{ seq: 1, body: "hey" }, { seq: 2, body: "what about cost?" }]).events.length, 0);
});

test("malformed blocks are rejected loudly, never half-parsed", () => {
  assert.throws(() => parseMessage(3, "claim:\ntext: A"), /missing 'runner'/); // claim without a check
  assert.throws(() => parseMessage(4, "open_tension:\ntext: t\nholds_open: 1"), /missing 'review_check'/);
  assert.throws(() => parseMessage(5, "result:\nclaim_seq: 1\noutcome: maybe\nevidence: x"), /must be pass\|fail/);
  assert.throws(() => parseMessage(6, "withdraw_tension:\ntension_seq: 1"), /missing 'reason'/);
  // a transcript containing a malformed block throws rather than producing a partial ledger
  assert.throws(() => ingest([{ seq: 7, body: "claim:\ntext: bad" }]), /malformed claim/);
});

test("jinstronda's claim: a tension is live only while it holds an open-or-failed claim", () => {
  const l = new Ledger();
  l.apply(claim(10, "A"));
  l.apply(result(11, 10, "fail")); // A is failed -> still open-or-failed
  l.apply(parseMessage(12, "open_tension:\ntext: T\nholds_open: 10\nreview_check: judge")!);
  assert.equal(l.tensionState(12), "live", "tension holding a failed claim is live");

  l.apply(result(13, 10, "pass")); // close A
  assert.equal(l.tensionState(12), "signaling", "when its held claim closes, the tension is kept and flagged signaling, not deleted");

  l.apply(claim(14, "B"));
  l.apply(result(15, 14, "fail")); // B failed
  l.apply(parseMessage(16, "retarget_tension:\ntension_seq: 12\nholds_open: 14\nreason: moved to B")!);
  assert.equal(l.tensionState(12), "live", "retargeting to a new failed claim clears signaling");
});

test("promote_tension and withdraw_tension are append-only terminal exits", () => {
  const l = new Ledger();
  l.apply(parseMessage(20, "open_tension:\ntext: T\nholds_open: 99\nreview_check: j")!);
  l.apply(parseMessage(21, "promote_tension:\ntension_seq: 20\nclaim: became a claim")!);
  assert.equal(l.tensionState(20), "promoted");

  const l2 = new Ledger();
  l2.apply(parseMessage(30, "open_tension:\ntext: T2\nholds_open: 98\nreview_check: j")!);
  l2.apply(parseMessage(31, "withdraw_tension:\ntension_seq: 30\nreason: not paying for it")!);
  assert.equal(l2.tensionState(30), "withdrawn");
});

test("the log is append-only — every applied event is retained in order", () => {
  const l = new Ledger();
  l.apply(claim(40, "X"));
  l.apply(result(41, 40, "fail"));
  l.apply(result(42, 40, "pass"));
  assert.deepEqual(l.events.map((e) => e.seq), [40, 41, 42]);
  assert.equal(l.isOpenOrFailed(40), false, "a claim with a PASS result is closed");
});
