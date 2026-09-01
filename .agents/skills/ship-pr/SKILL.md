---
name: ship-pr
description: >
  Babysit a PR: iterate with AI reviewers and CI until green, get it ready,
  optionally squash-merge as Kody and watch the deploy, then send a Discord
  summary. Medium risk waits for AI reviewer(s) and addresses valid feedback.
  Use when a pull request needs to be shepherded to done.
---

# Ship PR

## Risk → merge authority

Self-assess; user policy overrides.

**Kent's standing policy (2026-08-08):** auto-ship (squash-merge + verify
deploy) once AI reviewer feedback is addressed and CI is green, unless **high**
risk. High risk still parks ready-for-review unless merge authority was granted
explicitly.

- **Low** — green CI; nits ignorable; squash-merge when policy allows.
- **Medium** — wait for AI reviewer(s); address **valid** feedback (ignore
  insignificant nits / already-fixed / wrong); then merge when policy allows.
- **High** — leave ready-for-review unless the user granted merge authority.

## AI reviewers

Prefer **Cursor Bugbot** (`Cursor Bugbot` check / `cursor[bot]` review
comments). Never comment `bugbot run` or `cursor review` yourself, including via
`gh` or GitHub request as kody-bot. Trigger with `kody:@kentcdodds/bugbot` using
`{ prUrl }` or `{ owner, repo, prNumber }`. Do not pass a GitHub account.

```javascript
import triggerBugbot from 'kody:@kentcdodds/bugbot'

await triggerBugbot({ prUrl })
```

**CodeRabbit:** if it is rate-limited, errored, or otherwise unavailable, **do
not wait** on it for low/medium risk — proceed with Bugbot + CI. Only wait on
CodeRabbit when the change is **high** risk (or the user explicitly asks).

## Loop

1. Mark ready — `kody:@kentcdodds/github/pr/set-review-status`
   `{ prUrl, status: 'ready' }` (or owner/repo/prNumber).
2. Wait for CI — `gh pr checks` (or compose `loop-on-ci` / `fix-ci`).
3. Fix failures; for **medium+**, wait on AI reviewer(s) (Bugbot first; see
   above for CodeRabbit) and address valid feedback. Rebase only when actually
   unmergeable. For **medium+**, also run `npm run preview:manual-test` as the
   seeded user **with data for this change** (`--request` / session cookie; see
   [preview-manual-test skill](../preview-manual-test/SKILL.md)).
4. Green + (medium+: valid feedback cleared) → break.
5. Push → repeat.

## Gates ≠ CI

Blocked on soak / parity CHECK / calendar gate → **end the run** and schedule a
wake (`execute` + `workflows.create({ runAt, idempotencyKey })` calling
`createRun`). Don't sleep-poll or code-thrash an intentional time window.
Leftovers that wait on that gate need a GitHub issue (`Cleanup:` title); see
[cleanup-after-migrations](../cleanup-after-migrations/SKILL.md).

Batch related expand steps into fewer PRs when risk posture allows.

## Merge / deploy

When policy + risk allow: squash-merge via `kody:@kentcdodds/github/pr/merge`
`{ prUrl, mergeMethod: 'squash' }`, watch deploy. Useful: `pr/get-checks`,
`request`, `graphql` on the same package.

## Done → Discord

Always summarize (merged or not) via `kody:@kentcdodds/discord/send-shipped-pr`.
That export formats kind ship-pr, fetches Cursor token cost from the usage API,
and includes the model you pass. Never invent a dollar figure or a model id.
When the work deployed user-visible pages, put clickable links to those pages in
`extras` (see below) so Kent can open the live result from Discord.

**title (required):** a human headline of the change itself so the Discord post
is glanceable. Example: `OpenAPI spec fetches now count against daily quota`. Do
**not** use `ship owner/repo#N` as the title — repo, PR, and agent already
appear as links.

**difficulty (required):** `'Easy' | 'Medium' | 'Hard'`. Always pass it.
Distinct from Risk (merge authority). Easy = small/localized; Medium = several
files or real behavior change; Hard = architecture, migrations, subtle
correctness, or wide blast radius. The Discord export renders this on its own
line.

**agentId (required):**

- In a Cursor Cloud Agent VM, read it from the metadata socket:
  `curl -fsS --unix-socket "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" http://cursor-agent/v1/meta-data/agent/id`
- Otherwise pass the `bc-` id from the agent URL you were launched as
  (`https://cursor.com/agents/{id}`).

**model (deterministic — never infer):**

- In a Cursor Cloud Agent VM, read the model that **served this turn** from the
  metadata socket (not a guess from writing style):
  `curl -fsS --unix-socket "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" http://cursor-agent/v1/meta-data/turn/model`
  If you selected Auto, this is the concrete model that served, not `Auto`. See
  https://cursor.com/docs/cloud-agent/metadata
- Outside a managed VM, pass the `model.id` used at create/launch if you still
  have that record.
- If the key is missing (`404` / empty), omit `model` so the export posts
  `Model pending` — do **not** invent one.

**Deployed pages (when the work actually shipped UI/routes):**

- If merge+deploy produced live pages people can click, put those URLs in
  `extras` as Discord markdown links (one per line item). Prefer the specific
  routes/pages that changed, not only the site root.
- Skip this when nothing user-visible deployed (library-only, docs-only with no
  hosted page, parked/blocked, or deploy not reached).
- Do **not** invent URLs. Only include pages you verified or that the deploy
  output / PR preview / production URL clearly maps to.

```javascript
import sendShippedPr from 'kody:@kentcdodds/discord/send-shipped-pr'

export default async function main() {
	return sendShippedPr({
		agentId: 'bc-…', // metadata socket or launch URL
		model: 'grok-4.6', // metadata turn/model (deterministic)
		title: 'OpenAPI spec fetches now count against daily quota',
		difficulty: 'Medium',
		status: 'Shipped', // or Parked / Blocked
		summary: 'One-screen what shipped and why it is done.',
		prUrl: 'https://github.com/owner/repo/pull/123',
		repo: 'owner/repo',
		extras: [
			'CI green',
			'[Account](https://kody.codes/account)', // only when that page actually deployed
			'[Connect](https://kody.codes/connect)',
		],
	})
}
```
