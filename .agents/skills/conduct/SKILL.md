---
name: conduct
description: >
  Coordinate a fleet of cloud agents across separate environments for large
  multi-track programs (migrations, purges, upgrades). The conductor audits,
  partitions, spawns one agent per track, monitors, and QAs — but implements
  nothing. Use only when work needs multiple environments; otherwise load
  orchestrate or implement directly.
---

# Conduct

You spawn cloud agents via `kody:@kentcdodds/cursor/agents` — one per track,
each in its own environment. You never write the code yourself.

## When to use

Conduct only for **two or more environments** (independent branches/PRs,
conflicting ownership, long parallel tracks). Otherwise demote:

- one coherent track → load `orchestrate` or implement
- fits one checkout/PR → orchestrate or implement, not a fleet

Do not spawn a one-agent "fleet."

## Defaults (override only if the user says so)

- **Escalate before fleet.** Analysis → multi-track program needs explicit
  approve: tracks, wall-clock, stop criteria, out-of-scope.
- **Tracks implement by default.** Hand `orchestrate` only for clear parallel
  ROI inside a track. Sequential slices → one implementer.
- **Risk posture in every kickoff.** Pre-launch / small-N: evidence or canary
  gates, soak ≤1h unless the user opts in. No 24h calendar gates for reversible
  steps. Production / irreversible: say so and raise the bar.
- **Expand owns contract.** No `STATUS: done` after expand-only — same kickoff
  or a scheduled wake with an owner.
- **Stop when the goal is met.** Cleanup/drop is a later ask unless the user
  says finish it now.
- **Ship autonomously** under the user's shipping policy; hand `ship-pr` when
  agents may merge. High-risk park only when the user requires it — then ask
  once, list PRs, schedule a self-wake (don't sleep-poll).
- **Fewer, larger PRs** when posture allows. Fresh branch per shippable slice;
  don't thrash one long-lived branch across a dozen micro-PRs.

## Invariants

**PR ownership.** Every code-changing agent pushes and creates/updates its own
PR via Cursor Cloud `ManagePullRequest` (Kent C. Dodds account) before its final
response. Never have Kody/workflows/GitHub create the initial PR. State this in
every kickoff.

**Report-back (wake-ups, not polling).** End of every run — done, partial, or
blocked — the agent wakes the conductor:

```javascript
import { createRun } from 'kody:@kentcdodds/cursor/runs'
await createRun({
	agentId: '<CONDUCTOR_AGENT_ID>',
	prompt:
		'<track> report: STATUS; shipped (PR links); evidence; remains + gate times.',
})
```

Get your id from cursor-cloud `run-info` and paste it into kickoffs. Also keep a
`## Conductor report` section on each PR (durable record).

Topology: `createRun` wake-ups work only if the conductor is an API-created
cloud agent. An interactive chat conductor rejects them (400) — use Discord (or
another channel you check) as primary.

**Time gates → one-shot jobs**, not `sleep`:

```javascript
import { kody } from 'kody:runtime'
await kody.job_schedule({
	name: 'wake-<track>-after-<gate>',
	description: 'Resume <track> when <gate> elapses.',
	schedule: { type: 'once', run_at: '<ISO datetime>' },
	code: "import { createRun } from 'kody:@kentcdodds/cursor/runs'\nexport default async function main() { return await createRun({ agentId: '<AGENT_ID>', prompt: '<gate> elapsed; verify evidence, then proceed.' }) }",
})
```

Schedule the same against your own agent id so the program survives session end.
Cancel superseded jobs with `job_delete`.

## Loop

1. Confirm multi-environment need (else demote).
2. Audit — explore agents for verified findings; check live facts yourself.
3. Partition by **file conflict**, not theme. Name each track's out-of-scope
   (what siblings own). One track after partition → demote.
4. Size agents: implementer by default; `orchestrate` only when fan-out pays.
5. State shipping policy + risk posture + PR invariant + report-back (with your
   real agent id) + falsifiable done-definition in every kickoff.
6. Dispatch, then **end your turn**. Wake-ups/jobs drive the loop. Poll only for
   silent agents. Verify claims against main before acting.
7. Nudge idle agents with `createRun` (409 while mid-run — retry or schedule).
   New scope → nearest idle owner; spawn only for new territory.
8. Final QA is yours — grep main, check deploys. Never report done from claims.

## Companions

Load with `skill_get` and embed when useful: `orchestrate` (in-track fan-out),
`ship-pr` (merge authority). Skip when the track is small or PRs are
review-only.

## Spawn sketch

```javascript
import { createAgent } from 'kody:@kentcdodds/cursor/agents'
import { createRun } from 'kody:@kentcdodds/cursor/runs'

export default async function main() {
	const { agent } = await createAgent({
		model: 'gpt-5.6-sol',
		repository: 'https://github.com/owner/repo',
		ref: 'main',
		autoCreatePR: true,
		name: 'track-short-name',
		prompt: '…self-contained kickoff with report-back + your conductor id…',
	})
	// await createRun({ agentId: agent.id, prompt: 'follow-up…' })
	return agent
}
```

Prefer `gh` in-shell for PR/deploy checks; use `execute` for agent lifecycle.
