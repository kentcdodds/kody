# Manual preview testing

Use a PR preview when local `npm run validate` is not enough: medium or high
risk recaps (`extends` / `adds` in
[`.agents/skills/visual-recap/SKILL.md`](../../.agents/skills/visual-recap/SKILL.md)),
auth or deploy-path changes, or anything that needs the real isolated preview
workers, mocks, and seeded login.

This is a manual check. It does not replace `npm run validate`.

## One command

From the repo root, on a pushed PR branch, with `gh` authenticated:

```bash
npm run preview:manual-test
```

Same thing:

```bash
node tools/preview-manual-test.ts
```

The script:

1. Resolves the current PR (`gh pr view`, or pass `--pr <n>`).
2. Reads the `<!-- kody-preview-url -->` comment posted by
   `.github/workflows/preview.yml`.
3. Waits until `GET /health` returns `{ ok: true, commitSha }` matching the
   GitHub preview deployment SHA.
4. Smokes the preview without a browser: `/health`, `/login`, `/mcp` (401),
   runtime `/__runtime/health` when the URL is known, then `POST /auth`,
   `/session`, and `/account`.
5. Prints a briefing: URL, seed login, worker names, smoke results, and UI next
   steps.

Pass `--json` when a caller needs the structured result. Pass `--no-wait` to
fail immediately if the preview is not up yet. Pass `--url <preview-url>` to
skip GitHub discovery (useful once the comment already exists).

`--check /account/secrets` (repeatable) adds authenticated GET checks after
login.

## When a preview exists

Ready-for-review PRs on this repository (not forks, not drafts) get a per-PR
Cloudflare worker (`kody-pr-<n>`), isolated D1/KV, mock workers, and a seeded
login. The workflow comments the URL on the PR. Details of resource names and
cleanup live in [`setup.md`](./setup.md#pr-preview-deployments).

`/health` `commitSha` is GitHub's `github.sha` for that workflow run. On
`pull_request` events that is the merge commit, not the branch tip, so it can
differ from `HEAD` / `headRefOid`. The script compares against the GitHub
deployment SHA for `preview-<pr-number>` rather than local `HEAD`.

## Seed login

Preview seeding uses a **non-admin** account (the local `jane` companion is not
seeded remotely):

- Email: `me@kentcdodds.com`
- Password: `ilikecode`
- Username: `user-me`

Sign in at `/login` with Email + Password and the **Sign in** button. `/admin`
is expected to 403. Turnstile is off on preview (partial or missing keys stay
disabled), so password login works from a script or a browser.

`/mcp` stays OAuth-protected; an unauthenticated GET is 401 by design. Manual
preview testing is the browser app and HTTP smoke, not a full MCP OAuth dance.

## Manual UI pass

After the script succeeds:

1. Open the printed URL in a browser. On Cursor Cloud Agents, drive that with
   the `computerUse` subagent.
2. Log in with the seed credentials above.
3. Exercise the user-visible flows **this PR changes**. Stay on the preview
   origin (do not follow package-app handoff into production).
4. Note what you saw in the PR (pass, bug, screenshot). Keep the recap honest: a
   green smoke is not evidence that an untested flow works.

Do not point Playwright at the preview. Local E2E (`npm run test:e2e:run`) boots
its own worker against `.wrangler/state/e2e`.

## If the script cannot find a preview

- **Draft PR** — preview jobs skip drafts. Mark the PR ready for review, wait
  for 🔎 Preview, then re-run.
- **Fork PR** — the workflow skips forks.
- **Workflow still running** — default mode waits (15 minutes). Watch the run
  URL the script prints.
- **Workflow failed** — open the run, fix the deploy, push, re-run the script.
- **Stale URL after a push** — wait; a new deploy updates the same PR comment
  and `/health` `commitSha`.

Do not `gh workflow run preview.yml` with `target=pr` to "force" a PR preview.
That dispatch checks out the workflow's ref (usually `main`), not the PR head.
Pushing to the PR (or marking it ready) is the deploy trigger.

## Resource reset

Full preview resource delete/recreate remains the operator path in
[`setup.md`](./setup.md#reset-re-migrate-then-seed). The manual-test script does
not create or destroy Cloudflare resources.
