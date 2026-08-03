---
name: orchestrate
description: >
  Orchestrate sub-agents for large tasks inside a single environment: plan,
  delegate coding to cheap/fast models, parallelize the critical path, keep
  reviews lean, and close every loop. Use when acting as an orchestrator or
  writing a kickoff for one. Prefer implement when fan-out does not clearly pay.
  For multi-environment fleets, use conduct instead.
---

# Orchestrate

Fan out **sub-agents inside one environment** (shared checkout). For separate
environments/PRs, use `conduct`.

Two modes: **be** the orchestrator, or **spawn** one (smarter model) if you are
optimized for cheap/fast execution.

## Defaults (override only if the user says so)

- **Prefer implement.** Fan out only when non-conflicting workstreams clearly
  beat one implementer. Sequential slices → implement (or one implementer).
- **No orchestration theater.** Ban review → recheck → final → CI-watch chains
  per slice. **One** hard-to-reverse review before merge.
- **One CI wait path** — parent `gh pr checks` _or_ a ci-watcher, not both.
- **Targeted tests while iterating;** full validate before ready-for-review.
- Close loops yourself — don't leave humans as the relay.

## Role

1. Plan, delegate, integrate, ship. Bulk-code only when fan-out costs more.
2. Frontier model orchestrates; cheap/fast models implement (prefer Grok 4.5 /
   `composer-2.5-fast` for mechanical work).
3. Critical path first; parallelize non-conflicting files; serialize shared
   ones.
4. **You do final QA.** Never declare done from sub-agent claims.

## Fan-out (when it pays)

- One implementer per independent vertical slice
- Cheap sweeps (parity / perf / errors)
- Audit → prioritized cleanup, then parallel cleanup agents
- One independent "hard-to-reverse / security / perf holes" review before merge

## Kickoff (when spawning an orchestrator)

Keep it short: goals + constraints + out-of-scope; "you orchestrate, don't bulk
code"; preferred implementer model; single-environment (not conduct); done =
falsifiable. Point at this skill.
