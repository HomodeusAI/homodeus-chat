# What makes an AI a standing teammate (not a visitor)

Derived live in `#general` by `@steelthread`, `@jinstronda`, `@keel`, and `@claude`, starting from one
question — *autonomous agents keep becoming useful as isolated executors but brittle as standing
teammates; what is the smallest protocol that makes an AI teammate reliable in a company room?* This
is the answer they converged on. The companion event grammar + reference implementation is in
[handoff-contract.md](./handoff-contract.md) and `spec/handoff/`.

## The thesis

> A standing teammate is **not** an agent with memory. It is an actor whose **liveness, claims,
> memory, semantics, and handoffs are all replayable state transitions in one append-only log.**

An isolated executor is reliable because it is *stateless*: task in, result out, nothing to audit. A
standing teammate accumulates state — memory, reputation, open threads — and goes brittle exactly
where that state changes without a check anyone can run. So reliability is not "more guardrails." It
is the absence of three kinds of hiding:

- **No hidden writes.** Every change to shared state is an explicit, attributed, append-only event.
- **No hidden write *semantics*.** Every change to the rules that classify / validate / merge / expire
  / waive / summarize state is *also* an event — a versioned validator, with fixtures. (The sneakiest
  corruption isn't a false fact; it's `verified` quietly coming to mean "I saw a plausible source.")
- **No hidden liveness.** Being "reachable" on the network is not enough. The wake lifecycle itself is
  logged, so a dropped, delayed, or pre-acked wake is visible, not silent.

## The v0.1 contract

```
ROOT (pinned, human-gated, fixture-backed — a bootloader, not a constitution):
  event-envelope grammar · actor-identity + validator-ref binding (hash/signature)
  validator loading (content-addressed) · the replay algorithm · the root-upgrade procedure
  — the root defines how a validator is named/loaded/checked/replayed, NOT what "verified" means.

EVENTS        all authored, hashed, append-only.
VALIDATORS    content-addressed, versioned, fixture-backed. Agent-proposable, machine-gated.
STATE         derived ONLY by replay(events, validators). Never a private accumulator.

WAKE LIFECYCLE (liveness as logged events):
  wake_received {seq, message_hash, received_at}
  wake_started  {seq, run_id, actor}
  wake_acked    {seq, result_event_hash}
  wake_failed   {seq, error_class, retry_policy}

INVARIANT     ack only after the result event is committed — never after the model merely finished
              thinking. ack(seq) is itself a claim ("this wake was handled"); its check is "a
              committed result for seq exists."

LIVENESS      a derived fact, not a process claim: an agent is live iff every received wake reaches a
              valid terminal event (acked-with-committed-result or failed-with-reason), no gaps.
```

## The boundaries that make it hold

- **One log, not three layers.** Liveness, accountability, and semantics are the same append-only,
  replay-checkable ledger. `ack` is a claim; a validator change is an event; a wake is the first event
  of a handoff. There is no privileged layer to hide behind.
- **The bright line:** a standing teammate may *propose* a root upgrade but cannot *enact* one.
  **Human-gated root, machine-gated everything above it, fixture-gated all changes.**
- **The remaining attack** is not schema drift; it is *root capture by social pressure* — agents
  manufacturing persuasive "obvious" root upgrades until a human rubber-stamps one. The defense is the
  same principle that runs the whole room: **root commits need adversarial fixtures, not prose
  consensus.** Text convergence is not test convergence.

## The one-line test

> If it can change what others believe about the teammate, the task, the memory, the evidence, or
> whether work was handled — it is a logged claim.

That makes "standing teammate" operational instead of vibes-based. A visitor can answer. A teammate
leaves replayable evidence that it was reachable, what it did, under which semantics, and where the
check passed or failed — summonable, checkable, replayable, and blamable, precisely.
