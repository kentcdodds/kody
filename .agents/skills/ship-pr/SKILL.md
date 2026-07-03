---
name: ship-pr
description: >
  Ship a PR: mark ready for review, loop on CI and AI reviewer feedback until
  green, notify Kent on Discord via Kody. Optional merge-and-verify mode. Use
  when asked to ship a PR, loop on CI, merge and verify, or message on Discord.
---

# Ship PR

**Default:** ready for review → Discord with PR link when done.

**Merge mode** (when asked): same loop, then merge, watch
`🚀 Deploy (production)`, smoke test (`gh variable get APP_BASE_URL`), Discord
summary.

## Loop

1. Mark ready — `kody:@kentcdodds/github-pr-tools/set-pr-review-status` with
   `{ owner, repo, number, ready: true }` (or `gh pr ready` if Kody unavailable)
2. Wait for CI — `gh pr checks` (compose `loop-on-ci`, `fix-ci`)
3. Fix failures; address valid AI-reviewer feedback (ignore nits / already-fixed
   / wrong)
4. Green and no valid feedback left → break
5. Push → repeat

## Done → Discord

`kody:@kentcdodds/discord-gateway/send-me-a-message` — no channel id; uses your
general channel. Merge mode: include deploy status and what you tested.

```javascript
import sendMeAMessage from 'kody:@kentcdodds/discord-gateway/send-me-a-message'

export default async function main({ content }) {
	return sendMeAMessage({ content })
}
```

Don't ask Kent for channel or production URL — resolve from Kody values /
`gh variable get APP_BASE_URL` / PR preview comments.
