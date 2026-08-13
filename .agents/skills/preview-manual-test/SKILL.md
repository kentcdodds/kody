---
name: preview-manual-test
description: >
  Discover, wait for, smoke-check, and manually exercise a PR preview deploy.
  Use on medium or high risk PRs, after pushing a ready-for-review PR, or when
  the user asks to test the preview URL.
---

# Manual preview testing

Read
[`docs/contributing/preview-manual-testing.md`](../../../docs/contributing/preview-manual-testing.md)
and run the script. Do not improvise `gh` comment scraping or local E2E against
the preview URL.

## Command

```bash
npm run preview:manual-test
```

Useful flags: `--pr <n>`, `--url <preview-url>`, `--no-wait`, `--json`,
`--check /path`, `--skip-login`. `--help` prints the rest.

## When

Run this after the PR is **ready for review** (drafts and forks have no preview)
and you have pushed the commits you want to exercise. Typical triggers:
visual-recap risk is **medium** (`extends`) or **high** (`adds`); auth, workers,
or deploy-path behavior changed; the user asked to try the preview.

This does not replace `npm run validate`.

## After the briefing

1. Open the printed URL. On Cloud Agents, use the `computerUse` subagent.
2. Sign in at `/login`: `me@kentcdodds.com` / `ilikecode` (non-admin; username
   `user-me`). Button label is **Sign in**.
3. Exercise the flows this PR changes. Stay on the preview origin.
4. Record what you saw on the PR.

`GET /mcp` is 401 without OAuth; do not treat that as a regression. `/admin` is
403 on preview because the seed account is not an admin.
