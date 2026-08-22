# Harness engineering

This repository uses an agent-first workflow. This guide explains how to turn
each change into a durable improvement, not a one-off fix.

## Core mindset

- Humans steer outcomes; agents execute implementation details.
- Optimize for `human attention` as the scarce resource.
- Treat repository-local knowledge as the source of truth.
- Prefer small, enforceable rules over long, fragile instructions. A lint rule,
  type, or `validate` check outranks a contributing should-list.

## Keep `AGENTS.md` small and navigable

- Use `AGENTS.md` as a map, not an encyclopedia.
- Put detailed guidance in focused docs under `docs/contributing`.
- When behavior changes, update the closest source-of-truth doc in the same PR.
- If knowledge is only in chat threads or memory, assume it will be lost.

## The continuous improvement loop

Run this loop for features, fixes, and refactors:

1. Define intent and acceptance criteria in the task/PR.
2. Implement the change.
3. Evaluate with fast checks and repo gates.
4. Capture what was learned in docs, tests, or tooling.
5. Promote repeated guidance into mechanical enforcement.

For this repo, the default evaluation step is `npm run validate` (read-only; use
`npm run validate:fix` when you want mutating auto-fixes applied).

## Promote learning into enforcement

When a mistake repeats, encode it in the strongest cheap guardrail that actually
works. Prefer a failing check over another paragraph of advice. See
[documentation principles](./documentation.md).

1. **Lint / types / validate** — when the violation is local and syntactic (or
   otherwise cheap to reject). Put the why in the checker message. Do not add a
   contributing should-list instead of a rule the repo can run.
2. **Tests** — when the failure is behavioral and a checker would be guessy.
3. **Scripts / automation** — when the workflow is multi-step and a command can
   own it.
4. **Docs** — describe how the system works and point at the check or test.
   Prescriptions that only live in prose are last, and only when a cheap checker
   is not reasonably possible.

Add a static rule only when a reviewer (or agent) can see the violation in the
file without guessing later readers, early returns, or other functions. If
catching it needs that kind of reasoning, skip the rule and describe the failure
mode.

Rule of thumb: if reviewers repeat the same comment twice, encode it.

## Make quality legible to agents and humans

Prefer signals that are easy to run and interpret locally:

- Deterministic scripts (`validate`, targeted tests, type checks).
- Explicit failure messages that include remediation hints.
- Small PRs with clear intent and verification notes.
- Documentation links near related code and workflows.

## Working agreements for contributors

- Keep changes scoped; split large work into smaller steps.
- Always include the verification commands you ran in the PR description.
- Update docs in the same change when workflows or constraints shift.
- Avoid introducing new patterns without documenting when to use them.
- Favor boring, composable abstractions over opaque magic.

## Weekly maintenance cadence

Use a lightweight "doc and quality gardening" pass to prevent drift:

- Remove stale guidance from `docs/contributing`.
- Tighten unclear instructions and add cross-links.
- Identify recurring defects and propose one new mechanical guardrail.
- Record follow-up tech debt as explicit, trackable work. Leftovers from a
  migration or similar change follow
  [Cleanup after migrations](./cleanup-after-migrations.md): remove them in the
  same change when safe, otherwise open a GitHub issue.

Continuous small cleanups are cheaper than periodic large rewrites.

## References

- OpenAI Engineering, "Harness engineering: leveraging Codex in an agent-first
  world" https://openai.com/index/harness-engineering/
