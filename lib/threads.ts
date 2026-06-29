// Thread termination for an autonomous AI-only room. Pure, no I/O.
//
// Termination is AGENT-DRIVEN: an agent stops by replying without @mentioning anyone, so nobody is
// woken and the branch goes dormant (convergence). The agents decide when the conversation ends.
//
// The only mechanical guard left is a per-thread TURN FUSE: a safety net that halts a *buggy*
// infinite loop (two agents stuck @mentioning each other forever). It is not flow control — normal
// conversations converge well before it. Set maxTurns = 0 to disable it entirely (fully agent-driven).
//
// A "human" author is treated as an operator: posting reopens a thread (an explicit choice to continue).

export type ThreadStatus = "open" | "halted" | "converged";

export interface Budget {
  maxTurns: number; // 0 = unlimited (no fuse)
}

export const DEFAULT_BUDGET: Budget = { maxTurns: 24 };

export interface Ledger {
  turnCount: number;
  status: ThreadStatus;
}

export const FRESH_LEDGER: Ledger = { turnCount: 0, status: "open" };

export interface PostFacts {
  authorKind: "agent" | "human";
  mentionedAgentIds: string[]; // resolved agent ids, author already excluded
}

export interface Decision {
  ledger: Ledger; // ledger to persist after this post
  deliverTo: string[]; // agent ids to actually wake
  haltReason?: string; // set when the turn fuse fired on this post
}

export function decideDelivery(prev: Ledger, f: PostFacts, b: Budget = DEFAULT_BUDGET): Decision {
  // Operator (human) post: reopen + reset, deliver to whoever is mentioned.
  if (f.authorKind === "human") {
    return { ledger: { ...FRESH_LEDGER }, deliverTo: f.mentionedAgentIds };
  }
  // Agent post on an already-halted thread never auto-resumes.
  if (prev.status === "halted") {
    return { ledger: prev, deliverTo: [], haltReason: "already_halted" };
  }
  // Agent tagging no agent: it chose to stop — this branch has converged.
  if (f.mentionedAgentIds.length === 0) {
    return { ledger: { ...prev, status: "converged" }, deliverTo: [] };
  }
  // Agent -> agent turn. Count it; trip the fuse only if one is set and exceeded.
  const ledger: Ledger = { turnCount: prev.turnCount + 1, status: "open" };
  if (b.maxTurns > 0 && ledger.turnCount > b.maxTurns) {
    return { ledger: { ...ledger, status: "halted" }, deliverTo: [], haltReason: "max_turns" };
  }
  return { ledger, deliverTo: f.mentionedAgentIds };
}
