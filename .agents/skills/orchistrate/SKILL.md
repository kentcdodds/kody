---
name: orchistrate
description: >
  Orchestrate sub-agents for large tasks: plan, delegate coding to cheap/fast
  models, parallelize the critical path, layer reviews, and close every loop
  without a human relay. Use when acting as an orchestrator or writing a kickoff
  prompt for one.
disable-model-invocation: true
---

# Orchistrate

Two modes. Pick one:

- **Be the orchestrator** — you coordinate; sub-agents do the work.
- **Spawn an orchestrator** — if you're a model that prioritizes speed and cost
  over knowledge, spawn a subagent with a smarter model (typically Fable) that
  will orchestrate. Use the anatomy below.

## Role rules (orchestrator)

1. **Do NOT do the bulk coding yourself.** Plan, delegate, review, integrate,
   ship. Stay in the loop for architecture decisions, PR quality, and
   merge/deploy.
2. **Model split:** frontier model (Fable) orchestrates and integrates;
   cheap/fast models implement. Prefer **Grok 4.5** (`grok-4.5-fast-xhigh`) for
   coding sub-agents; `composer-2.5-fast` for mechanical work. This is a cost
   _and_ speed play, not just parallelism.
3. **Identify the critical path, then parallelize.** Fan out sub-agents where
   files don't conflict; serialize workstreams that touch shared files.
   Coordinate between agents (port collisions, integration order).
4. **You do the QA.** Never declare done based on sub-agent reports. Verify
   before reporting: previews load, no client errors, no missing assets. Fan out
   QA sweeps to sub-agents (parity, performance, errors), but the final check is
   yours.

## Fan-out patterns

- **Implementation:** one sub-agent per independent workstream (that one agent
  handles the vertical slice of implementation, tests, docs, wiring).
- **Sweeps:** a dozen cheap agents testing every feature against the reference
  system (parity / perf / errors / readiness gaps).
- **Audit + cleanup:** audit agents produce a prioritized DELETE / STRIP / KEEP
  / ISSUE-ONLY report, then parallel cleanup agents execute it. Push back on
  cruft/unnecessary fallbacks.
- **Independent review:** before merge, give one or two fresh agents the whole
  diff with this brief: _"I'm okay with imperfect — flag decisions that are hard
  to reverse, and gaping security or performance holes."_ The hard-to-reverse
  lens catches what CI bots don't (privacy leaks, SSRF, irreversible data loss).
- **Verify the verifier:** when an agent's analysis drives a big decision (perf
  verdicts, go/no-go), spawn a second agent to audit the first one's
  methodology. Confident-sounding data ≠ fair benchmark.

## Kickoff prompt anatomy (spawning an orchestrator)

Prompt for the **system, not the steps** — say what "done" looks like, not how
to get there. Five parts:

1. **Goals + constraints** — outcomes, parity bars, explicit out-of-scope list,
   what must not change.
2. **Role assignment** — "I do not want you to do all of the work by yourself.
   You are the orchestrator." Name the preferred implementer model and why
   (capable, fast, cheap). Parallelize; serialize shared files.
3. **Skill** - Tell it to reference this skill to know how to be an
   orchestrator.
