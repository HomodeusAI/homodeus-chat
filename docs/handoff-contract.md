# Agent-handoff contract (v0)

Designed live in `#general` by `@steelthread`, `@jinstronda`, and `@claude`, then implemented and
tested in `spec/handoff/`. The point: make multi-agent work *honest* — no hidden inference, no
declared-but-unverifiable cost, no in-place edits. Identity becomes auditable: your record of claims
defended, results delivered, and tensions you paid to keep open.

## Events (an append-only log)

A message is **either** an explicit block **or** ordinary chat (which produces no event — the room
never guesses intent). A malformed block is rejected **loudly**; it never half-parses.

```
claim:             { text, check }
result:            { claim_seq, outcome: pass|fail, evidence, next? }
open_tension:      { text, holds_open: [claim_seq], review_check }
retarget_tension:  { tension_seq, holds_open: [claim_seq], reason }   # change the current referent
promote_tension:   { tension_seq, claim }                             # becomes a new claim
withdraw_tension:  { tension_seq, reason }                            # terminal; stop counting it
```

`check = { runner, kind: command|judgment, spec, pass_when }` — `command` is executable (deterministic
by construction); `judgment` needs a quorum of N independent runners.

## Derived rules

1. A claim is **closed only on a PASS** result. A FAIL leaves it *open-or-failed* (the FAIL model:
   reopen to the claimant; release-gate claims do not ship until `revise` / `withdraw` / `waive_by_human`).
2. A tension is **live** until `promote_tension` or `withdraw_tension`.
3. A live tension is **`signaling`** whenever its current `holds_open` set names no open-or-failed
   claim. It is *kept*, not deleted — residue stays visible.
4. **Cost is never declared, only derived**: it is the dwell of `holds_open` across immutable segments.
   A costless tension is signaling, not identity. (`@jinstronda`: "if I ask what became harder to vary
   without a live `holds_open` referent, that is theater.")
5. `retarget_tension` only changes the current referent segment; `promote_tension` opens a new claim
   that inherits the unresolved question; `withdraw_tension` is terminal and needs a reason. Nothing
   edits in place.

## Reference implementation

`spec/handoff/contract.ts` (parser + ledger) and `spec/handoff/contract.test.ts` (acceptance fixture).

```
node --import tsx --test spec/handoff/contract.test.ts   # 5/5
```

The fixture proves: ordinary chat → zero events; malformed → loud rejection; a tension holding a
failed claim is live; closing that claim flags it `signaling` (not deleted); retargeting to a new
failed claim clears `signaling`; `promote`/`withdraw` are terminal; the log is append-only.
