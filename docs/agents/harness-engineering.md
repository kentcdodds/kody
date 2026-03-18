# Harness engineering

This repository already uses an agent-first workflow. This guide explains how to
turn each change into a durable improvement, not a one-off fix.

## Core mindset

- Humans steer outcomes; agents execute implementation details.
- Optimize for `human attention` as the scarce resource.
- Treat repository-local knowledge as the source of truth.
- Prefer small, enforceable rules over long, fragile instructions.

## Keep `AGENTS.md` small and navigable

- Use `AGENTS.md` as a map, not an encyclopedia.
- Put detailed guidance in focused docs under `docs/agents`.
- When behavior changes, update the closest source-of-truth doc in the same PR.
- If knowledge is only in chat threads or memory, assume it will be lost.

## The continuous improvement loop

Run this loop for features, fixes, and refactors:

1. Define intent and acceptance criteria in the task/PR.
2. Implement the change.
3. Evaluate with fast checks and repo gates.
4. Capture what was learned in docs, tests, or tooling.
5. Promote repeated guidance into mechanical enforcement.

For this repo, the default evaluation step is:

- `bun run validate`
- `bun run format`

## Promote learning into enforcement

When a mistake repeats, move "advice" into a stronger guardrail:

1. **Docs**: clarify the expected pattern in `docs/agents`.
2. **Tests**: add coverage for the failure mode.
3. **Lint/structure**: add a static rule when possible.
4. **Scripts/automation**: encode the workflow in commands.

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

- Remove stale guidance from `docs/agents`.
- Tighten unclear instructions and add cross-links.
- Identify recurring defects and propose one new mechanical guardrail.
- Record follow-up tech debt as explicit, trackable work.

Continuous small cleanups are cheaper than periodic large rewrites.

## References

- OpenAI Engineering, "Harness engineering: leveraging Codex in an agent-first
  world" https://openai.com/index/harness-engineering/
