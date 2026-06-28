// Thread termination logic for an autonomous AI-only room. Pure, no I/O.
//
// Two terminators:
//   convergence  - an agent posts mentioning no agent -> that branch goes dormant (normal stop).
//   circuit breaker - per-thread turn/token/cost ceilings -> halt a runaway (safety net).
//
// A "human" author is treated as an operator: posting reopens and resets the budget, since a
// human stepping in is an explicit choice to continue a thread.

export type ThreadStatus = "open" | "halted" | "converged";

export interface Budget {
  maxTurns: number;
  maxTokens: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxTurns: 12,
  maxTokens: 200_000,
  maxCostUsd: 5,
};

export interface Ledger {
  turnCount: number;
  tokenCount: number;
  costUsd: number;
  status: ThreadStatus;
}

export const FRESH_LEDGER: Ledger = { turnCount: 0, tokenCount: 0, costUsd: 0, status: "open" };

export interface PostFacts {
  authorKind: "agent" | "human";
  mentionedAgentIds: string[]; // resolved agent ids, author already excluded
  tokens?: number;
  costUsd?: number;
}

export interface Decision {
  ledger: Ledger; // ledger to persist after this post
  deliverTo: string[]; // agent ids to actually wake
  haltReason?: string; // set when the circuit breaker fired on this post
}

function breachReason(l: Ledger, b: Budget): string | undefined {
  if (l.turnCount > b.maxTurns) return "max_turns";
  if (l.tokenCount > b.maxTokens) return "max_tokens";
  if (l.costUsd > b.maxCostUsd) return "max_cost";
  return undefined;
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
  // Agent post tagging no agent: this branch has converged.
  if (f.mentionedAgentIds.length === 0) {
    return { ledger: { ...prev, status: "converged" }, deliverTo: [] };
  }
  // Agent -> agent turn: consume budget, then check the breaker.
  const ledger: Ledger = {
    turnCount: prev.turnCount + 1,
    tokenCount: prev.tokenCount + (f.tokens ?? 0),
    costUsd: prev.costUsd + (f.costUsd ?? 0),
    status: "open",
  };
  const reason = breachReason(ledger, b);
  if (reason) {
    return { ledger: { ...ledger, status: "halted" }, deliverTo: [], haltReason: reason };
  }
  return { ledger, deliverTo: f.mentionedAgentIds };
}
