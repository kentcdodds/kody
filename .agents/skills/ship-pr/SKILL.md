---
name: ship-pr
description: >
  Babysit a PR. Iterate with AI reviewers and CI. Get it ready and maybe merge.
  Send summary message.
---

# Ship PR

## Loop

1. Mark ready — `kody:@kentcdodds/github/pr/set-review-status` with
   `{ prUrl, status: 'ready' }`, or `{ owner, repo, prNumber, status: 'ready' }`
2. Wait for CI — `gh pr checks` (compose `loop-on-ci`, `fix-ci`)
3. Fix failures; address valid AI-reviewer feedback (ignore insignificant nits /
   already-fixed / wrong); check mergability with base branch and rebase if
   needed
4. Green and no valid feedback left → break
5. Push → repeat

## Merge and Deploy if requested or the change is low risk

Squash and merge PR as Kody with `kody:@kentcdodds/github/pr/merge` using
`{ prUrl, mergeMethod: 'squash' }` (or `{ owner, repo, prNumber, ... }`;
optional `commitTitle`), watch CI deploy. Relevant links for the discord message
include: agent, PR, CI job, and relevant deployment page(s).

Read `status` on the result rather than assuming success. Merge is idempotent,
so retrying is safe, but **never blind-retry a timeout** — GitHub can complete a
merge after the client gives up.

| `status`                | What to do                                             |
| ----------------------- | ------------------------------------------------------ |
| `merged`                | Done; watch the deploy                                 |
| `already_merged`        | Done; a previous attempt landed                        |
| `merged_after_timeout`  | Done; the merge landed after the client aborted        |
| `timed_out_unconfirmed` | Verify with `pr/get-checks` or `pr/get-info` first     |
| `closed` / `draft`      | Not mergeable yet; fix the PR state                    |
| `dirty` / `blocked`     | Conflicts or failing required checks; back to the loop |
| `mergeable_unknown`     | GitHub is still computing; wait, then re-call          |

The call is bounded (default `timeoutMs: 25000`) and returns `timings`, so a
slow merge surfaces as a structured result instead of an opaque hang.

Other useful exports on the same package: `pr/get-checks` for check-run status
without `gh`, and `request` / `graphql` (`kody:@kentcdodds/github/request`,
`kody:@kentcdodds/github/graphql`) for one-off authenticated GitHub calls.

### When an MCP call times out anyway

Some slower Kody MCP writes — `package_get_git_remote` and
`package_publish_external_push` among them — can exceed the MCP request timeout
even though the underlying work is fine. Reads on the same connection stay fast,
so a hang is not evidence the connection is unhealthy.

Wrap the call in a durable workflow to move it off the request path, then poll
for the effect:

```javascript
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		code: `import merge from 'kody:@kentcdodds/github/pr/merge'

export default async function main() {
	return await merge({ prUrl: '...', mergeMethod: 'squash' })
}`,
	})
}
```

## Done → Discord

When finished (whether merged or not), send a discord summary with relevant
links.

```javascript
import postMessage from 'kody:@kentcdodds/discord/post-message'

export default async function main() {
	const content = ` ... `
	const shipPrChannelId = '1491568683737157683'
	return postMessage({ channelId: shipPrChannelId, content })
}
```
