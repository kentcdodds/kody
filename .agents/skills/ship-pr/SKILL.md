---
name: ship-pr
description: >
  Ship a PR: mark ready for review, loop on CI and AI reviewer feedback until
  green, notify Kent on Discord via Kody. Optional merge-and-verify mode. Use
  when asked to ship a PR, loop on CI, merge and verify, or message on Discord.
---

# Ship PR

**Default mode:** ready for review → Discord with PR link when done.

**Merge mode** (when user asks to merge): same loop, then merge, watch
production deploy, smoke test, Discord summary.

## Loop

1. Mark PR ready for review (Kody `github-pr-tools/set-pr-review-status`,
   `ready: true`)
2. Wait for CI (`gh pr checks`)
3. Fix failures; address valid AI-reviewer bot feedback (ignore
   nits/already-fixed/wrong)
4. If green and no valid feedback left → break
5. Push → repeat

Compose `loop-on-ci`, `fix-ci`, and `get-pr-comments` when helpful.

## Discord (Kody)

Default: `discord-gateway/send-me-a-message` with the PR link and a one-liner.
No channel id needed — it uses your configured general channel.

Merge mode: include what merged, deploy status, and what you tested.

## Merge-and-verify extras

After the loop: merge → watch `🚀 Deploy (production)` → smoke test production
(`gh variable get APP_BASE_URL` for the URL) → Discord summary.

## Resolve from Kody/repo (don't ask Kent)

- Discord channel: `./send-me-a-message` (or search `*DiscordChannelId` values
  if a specific channel is named)
- Production URL: `gh variable get APP_BASE_URL`; preview URL from PR comments
  if testing before merge
- Mark ready / PR info: `github-pr-tools` package
