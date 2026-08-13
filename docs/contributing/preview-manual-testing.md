# Manual preview testing

Use a PR preview when local `npm run validate` is not enough: medium or high
risk recaps (`extends` / `adds` in
[`.agents/skills/visual-recap/SKILL.md`](../../.agents/skills/visual-recap/SKILL.md)),
auth or deploy-path changes, or anything that needs the real isolated preview
workers, mocks, and a **logged-in user with the data the change cares about**.

This does not replace `npm run validate`. A green health/login smoke is not
evidence that an untested flow works.

## One command

From the repo root, on a pushed PR branch, with `gh` authenticated:

```bash
npm run preview:manual-test
```

Same thing: `node tools/preview-manual-test.ts`.

The script signs in as the preview seed user and keeps that session. The seed
account starts **empty** except the user row — there are no secrets, values,
packages, or jobs until you create them. Create that data and assert the change
as the same user:

```bash
npm run preview:manual-test -- \
  --request 'POST /account/values.json {"action":"save","name":"preview-locale","value":"en-US"}' \
  --request 'GET /account/values.json' \
  --check /account/values
```

`--request` is authenticated HTTP as the seed user. Spec:
`METHOD /path [expected-status] [json-body]`. Default success is any 2xx.
Example negative check: `--request 'GET /admin 403'`.

`--json` prints `session.cookieHeader` so follow-up `curl` can reuse the
session. `--cookie-file .tmp/preview-cookie` writes that header value:

```bash
COOKIE=$(cat .tmp/preview-cookie)
curl -sS -H "Cookie: $COOKIE" -H 'Accept: application/json' \
  "$PREVIEW_URL/account/values.json"
```

`--no-wait` fails immediately if the preview is not up. `--url` skips GitHub
discovery. `--help` lists the rest.

On medium or high risk, running only the default smoke (health + empty login) is
not enough. Add `--request` / `--check` for the flows this PR changes, or reuse
the session cookie and drive those APIs yourself. Then do a UI pass.

## When a preview exists

Ready-for-review PRs on this repository (not forks, not drafts) get a per-PR
Cloudflare worker (`kody-pr-<n>`), isolated D1/KV, mock workers, and a seeded
login. The workflow comments the URL on the PR. Details of resource names and
cleanup live in [`setup.md`](./setup.md#pr-preview-deployments).

`/health` `commitSha` is GitHub's `github.sha` for that workflow run. On
`pull_request` events that is the merge commit, not the branch tip, so it can
differ from `HEAD` / `headRefOid`. GitHub environment deployments record the PR
head SHA, not that merge commit. The script treats `/health` as ready when
`commitSha` equals the PR head **or** is a merge commit that has the PR head as
a parent. Pass `--sha` to override the expected commit.

## Seed login

Preview seeding uses a **non-admin** account (the local `jane` companion is not
seeded remotely):

- Email: `me@kentcdodds.com`
- Password: `ilikecode`
- Username: `user-me`

The script signs in through `POST /auth` (Turnstile is off on preview). Sign in
in a browser at `/login` with Email + Password and the **Sign in** button.
`/admin` is expected to 403.

Do not seed preview D1 from the agent VM with `tools/ci/preview-resources.ts`
unless you are an operator with Cloudflare credentials. Create user data through
the product JSON APIs instead (`/account/*.json` in
`packages/worker/universal/routes.ts`). Those are the same endpoints the UI
posts to.

`/mcp` stays OAuth-protected; an unauthenticated GET is 401 by design. Logged-in
preview testing is the browser app and cookie-backed HTTP, not a full MCP OAuth
dance.

## Logged-in data and UI pass

1. Run the script with `--request` (and `--check` for HTML) covering the change.
2. If you need a longer session, take `session.cookieHeader` from `--json` or
   `--cookie-file` and `curl` more endpoints.
3. Open the preview URL (computerUse on Cloud Agents), sign in with the seed
   credentials, and confirm the same data in the UI. Stay on the preview origin
   (do not follow package-app handoff into production).
4. Record what you saw in the PR.

Do not point Playwright at the preview. Local E2E (`npm run test:e2e:run`) boots
its own worker against `.wrangler/state/e2e`.

## If the script cannot find a preview

- **Draft PR** — preview jobs skip drafts. Mark the PR ready for review, wait
  for 🔎 Preview, then re-run.
- **Fork PR** — the workflow skips forks.
- **Workflow still running** — default mode waits (15 minutes). Watch the run
  URL the script prints.
- **Workflow failed** — open the run, fix the deploy, push, re-run the script.
- **Stale URL after a push** — `/health` can still match the previous deployment
  SHA until GitHub records a new preview deployment. The script waits until the
  🔎 Preview workflow run for this PR head is `completed`/`success` (unless you
  pass `--url` without `--pr`) and `/health` matches the expected SHA. Do not
  treat a healthy worker as the new commit until that happens.

Do not `gh workflow run preview.yml` with `target=pr` to "force" a PR preview.
That dispatch checks out the workflow's ref (usually `main`), not the PR head.
Pushing to the PR (or marking it ready) is the deploy trigger.

## Resource reset

Full preview resource delete/recreate remains the operator path in
[`setup.md`](./setup.md#reset-re-migrate-then-seed). The manual-test script does
not create or destroy Cloudflare resources.
