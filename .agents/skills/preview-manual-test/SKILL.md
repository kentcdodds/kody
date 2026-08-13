---
name: preview-manual-test
description: >
  Discover, wait for, sign in, create specific user data, and assert a PR
  preview deploy. Use on medium or high risk PRs, after pushing a
  ready-for-review PR, or when the user asks to test the preview URL.
---

# Manual preview testing

Read
[`docs/contributing/preview-manual-testing.md`](../../../docs/contributing/preview-manual-testing.md).
Do not improvise `gh` comment scraping, local E2E against the preview URL, or
raw D1 seeding of preview resources.

## Command

```bash
npm run preview:manual-test
```

On **medium or high risk**, do not stop at the default health/login smoke. The
seed user (`me@kentcdodds.com` / `ilikecode`, username `user-me`) has **no**
secrets, values, packages, or jobs until you create them. Script that data and
the assertions as the same logged-in user:

```bash
npm run preview:manual-test -- \
  --request 'POST /account/values.json {"action":"save","name":"preview-locale","value":"en-US"}' \
  --request 'GET /account/values.json' \
  --check /account/values
```

`--request` spec: `METHOD /path [status] [json-body]` (default success: 2xx).
Use the JSON APIs the UI uses (`/account/*.json` in
`packages/worker/universal/routes.ts`). `--json` includes
`session.cookieHeader`; `--cookie-file` writes it for follow-up `curl`.

`--pr`, `--url`, `--no-wait`, `--skip-login`, `--help` as documented.

## When

After the PR is **ready for review** (drafts and forks have no preview) and you
have pushed the commits you want to exercise. Typical triggers: visual-recap
risk is **medium** (`extends`) or **high** (`adds`); auth, workers, or
deploy-path behavior changed; the user asked to try the preview.

This does not replace `npm run validate`.

## After the scripted session

1. Open the printed URL. On Cloud Agents, use the `computerUse` subagent.
2. Sign in at `/login` with the seed credentials. Button label is **Sign in**.
3. Confirm the data you created and exercise the UI this PR changes. Stay on the
   preview origin.
4. Record what you saw on the PR.

`GET /mcp` is 401 without OAuth; `/admin` is 403 (seed account is not admin).
Neither is a regression.
