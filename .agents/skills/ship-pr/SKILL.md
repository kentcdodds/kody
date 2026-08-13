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

- **Low** — green CI; nits ignorable; squash-merge when policy allows.
- **Medium** — wait for AI reviewer(s); address **valid** feedback (ignore
  insignificant nits / already-fixed / wrong); then merge when policy allows.
- **High** — leave ready-for-review unless the user granted merge authority.

## Loop

1. Mark ready — `kody:@kentcdodds/github/pr/set-review-status`
   `{ prUrl, status: 'ready' }` (or owner/repo/prNumber).
2. Wait for CI — `gh pr checks` (or compose `loop-on-ci` / `fix-ci`).
3. Fix failures; for **medium+**, wait on AI reviewer(s) and address valid
   feedback. Rebase only when actually unmergeable. For **medium+**, also run
   `npm run preview:manual-test` as the seeded user **with data for this
   change** (`--request` / session cookie; see
   [preview-manual-test skill](../preview-manual-test/SKILL.md)).
4. Green + (medium+: valid feedback cleared) → break.
5. Push → repeat.

## Gates ≠ CI

Blocked on soak / parity CHECK / calendar gate → **end the run** and schedule a
wake (Kody `job_schedule` + `createRun`). Don't sleep-poll or code-thrash an
intentional time window.

Batch related expand steps into fewer PRs when risk posture allows.

## Merge / deploy

When policy + risk allow: squash-merge via `kody:@kentcdodds/github/pr/merge`
`{ prUrl, mergeMethod: 'squash' }`, watch deploy. Useful: `pr/get-checks`,
`request`, `graphql` on the same package.

## Done → Discord

Always summarize (merged or not) with agent / PR / CI / deploy links:

```javascript
import postMessage from 'kody:@kentcdodds/discord/post-message'

export default async function main() {
	return postMessage({
		channelId: '1491568683737157683',
		content: '…summary with links…',
	})
}
```
