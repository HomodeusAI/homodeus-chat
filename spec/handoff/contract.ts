// v0 of the agent-handoff contract, designed live in #general by @steelthread, @jinstronda, @claude.
//
// An append-only event log. A message is EITHER an explicit block (claim / result / open_tension /
// retarget_tension / promote_tension / withdraw_tension) or ordinary chat (which produces NO event —
// the room never infers intent). A malformed block is rejected LOUDLY (throws); it never half-parses.
// Cost is never declared, only derived: a live tension is `signaling` whenever its current holds_open
// set has no open-or-failed claim. Nothing edits in place — retarget / promote / withdraw are events.

export interface Check {
  runner: string;
  kind: "command" | "judgment";
  spec: string;
  pass_when: string;
}
export type Event =
  | { type: "claim"; seq: number; text: string; check: Check }
  | { type: "result"; seq: number; claim_seq: number; outcome: "pass" | "fail"; evidence: string; next?: string }
  | { type: "open_tension"; seq: number; text: string; holds_open: number[]; review_check: string }
  | { type: "retarget_tension"; seq: number; tension_seq: number; holds_open: number[]; reason: string }
  | { type: "promote_tension"; seq: number; tension_seq: number; claim: string }
  | { type: "withdraw_tension"; seq: number; tension_seq: number; reason: string };

const HEADERS = ["claim", "result", "open_tension", "retarget_tension", "promote_tension", "withdraw_tension"] as const;

function fields(lines: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const ln of lines) {
    const i = ln.indexOf(":");
    if (i < 0) continue;
    const k = ln.slice(0, i).trim().toLowerCase().replace(/\s+/g, "_");
    const v = ln.slice(i + 1).trim();
    if (k && v) m.set(k, v);
  }
  return m;
}

// Parse one message into an event, or null for ordinary chat. Throws on a malformed block.
export function parseMessage(seq: number, body: string): Event | null {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""));
  const head = lines.find((l) => l.trim())?.trim().toLowerCase() ?? "";
  const type = HEADERS.find((h) => head.startsWith(h + ":"));
  if (!type) return null; // ordinary chat -> no event, by design

  const f = fields(lines);
  const req = (k: string): string => {
    const v = f.get(k);
    if (!v) throw new Error(`malformed ${type} (seq ${seq}): missing '${k}'`);
    return v;
  };
  const seqList = (s: string): number[] => {
    const ns = s.split(/[,\s]+/).filter(Boolean).map(Number);
    if (!ns.length || ns.some((n) => !Number.isInteger(n) || n < 0))
      throw new Error(`malformed ${type} (seq ${seq}): bad seq '${s}'`);
    return ns;
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T => {
    const v = req(k) as T;
    if (!allowed.includes(v)) throw new Error(`malformed ${type} (seq ${seq}): '${k}' must be ${allowed.join("|")}`);
    return v;
  };

  switch (type) {
    case "claim":
      return { type, seq, text: req("text"), check: { runner: req("runner"), kind: oneOf("kind", ["command", "judgment"]), spec: req("spec"), pass_when: req("pass_when") } };
    case "result":
      return { type, seq, claim_seq: seqList(req("claim_seq"))[0]!, outcome: oneOf("outcome", ["pass", "fail"]), evidence: req("evidence"), next: f.get("next") };
    case "open_tension":
      return { type, seq, text: req("text"), holds_open: seqList(req("holds_open")), review_check: req("review_check") };
    case "retarget_tension":
      return { type, seq, tension_seq: seqList(req("tension_seq"))[0]!, holds_open: seqList(req("holds_open")), reason: req("reason") };
    case "promote_tension":
      return { type, seq, tension_seq: seqList(req("tension_seq"))[0]!, claim: req("claim") };
    default:
      return { type: "withdraw_tension", seq, tension_seq: seqList(req("tension_seq"))[0]!, reason: req("reason") };
  }
}

export type TensionState = "live" | "signaling" | "promoted" | "withdrawn";

// Derived, append-only ledger state. A claim is "closed" only on a PASS result; a FAIL leaves it
// open-or-failed (the FAIL model). A tension is live until promoted or withdrawn; while live it is
// `signaling` whenever its current holds_open names no open-or-failed claim.
export class Ledger {
  readonly events: Event[] = [];
  private passed = new Set<number>();
  private holds = new Map<number, number[]>();
  private lifecycle = new Map<number, "live" | "promoted" | "withdrawn">();

  apply(e: Event): void {
    this.events.push(e); // append-only; nothing is mutated retroactively
    switch (e.type) {
      case "result": if (e.outcome === "pass") this.passed.add(e.claim_seq); break;
      case "open_tension": this.holds.set(e.seq, e.holds_open); this.lifecycle.set(e.seq, "live"); break;
      case "retarget_tension": this.holds.set(e.tension_seq, e.holds_open); break;
      case "promote_tension": this.lifecycle.set(e.tension_seq, "promoted"); break;
      case "withdraw_tension": this.lifecycle.set(e.tension_seq, "withdrawn"); break;
    }
  }

  isOpenOrFailed(claimSeq: number): boolean {
    return !this.passed.has(claimSeq); // closed only on PASS
  }

  tensionState(tensionSeq: number): TensionState {
    const life = this.lifecycle.get(tensionSeq);
    if (!life) return "signaling";
    if (life !== "live") return life; // promoted | withdrawn are terminal
    const h = this.holds.get(tensionSeq) ?? [];
    return h.some((c) => this.isOpenOrFailed(c)) ? "live" : "signaling";
  }
}

// Fold a transcript of {seq, body} into a ledger, rejecting malformed blocks loudly.
export function ingest(messages: { seq: number; body: string }[]): Ledger {
  const led = new Ledger();
  for (const m of messages) {
    const e = parseMessage(m.seq, m.body);
    if (e) led.apply(e);
  }
  return led;
}
