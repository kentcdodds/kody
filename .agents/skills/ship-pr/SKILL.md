---
name: ship-pr
description: >
  Babysit a PR. Iterate with AI reviewers and CI. Get it ready and maybe merge.
  Send summary message.
---

# Ship PR

## Loop

1. Mark ready — `kody:@kentcdodds/github-pr-tools/set-pr-review-status` with
   `{ owner, repo, number, ready: true }`
2. Wait for CI — `gh pr checks` (compose `loop-on-ci`, `fix-ci`)
3. Fix failures; address valid AI-reviewer feedback (ignore insignificant nits /
   already-fixed / wrong)
4. Green and no valid feedback left → break
5. Push → repeat

## Mode

By default, continue to Discord message with summary and include PR link

If explicitly requested, merge PR as Kody, watch CI deploy, when finished,
continue to the discord message and include a summary with link to PR, deployed
URL link, or failing job link.

## Done → Discord

```javascript
import sendMeAMessage from 'kody:@kentcdodds/discord-gateway/send-me-a-message'

export default async function main() {
	const content = ` ... `
	return sendMeAMessage({ content })
}
```
