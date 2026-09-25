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

Same thing: `node tools/preview-manual-test.ts`, or
`npm run control-kody -- preview --pr <n>` (flags after `preview` go to this
script; a `--` separator is optional).

The script signs in as the preview seed user and keeps that session. The seed
account starts **empty** except the user row — there are no secrets, packages,
or jobs until you create them. Create that data and assert the change as the
same user. For a saved package, use `package-create` (not a create action on
`POST /account/packages.json`):

```bash
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]
```

For arbitrary MCP `execute` or `search` as the same seed user (fixtures,
`jobRunNow`, probing `kody:runtime`), use the CLI instead of a throwaway OAuth
script:

```bash
npm run control-kody -- execute --origin <preview> --code-file fixture.ts [--params-file params.json]
npm run control-kody -- search --origin <preview> --query "packageSave"
```

JSON APIs still cover other account data:

```bash
npm run preview:manual-test -- \
  --request 'POST /onboarding/checklist-dismiss.json {}' \
  --request 'GET /onboarding.json' \
  --check /onboarding/step-2
```

`--request` is authenticated HTTP as the seed user. Spec:
`METHOD /path [expected-status] [json-body]`. Default success is any 2xx.
Example negative check: `--request 'GET /admin 403'`.

`--json` includes session metadata for the scripted run. For more authenticated
HTTP, use `control-kody request` with the same `--origin` (and `--dump` /
`--contains` for HTML). Do not `cat` the session cookie into `curl` or Python.

`--no-wait` fails immediately if the preview is not up. `--url` skips GitHub
discovery. `--help` lists the rest.

On medium or high risk, running only the default smoke (health + empty login) is
not enough. Add `--request` / `--check` for the flows this PR changes, or run
`control-kody request` against the same origin. Then do a UI pass.

## When a preview exists

Ready-for-review PRs on this repository (not forks, not drafts) get a per-PR
origin worker (`kody-pr-<n>`), sibling platform, runtime, and jobs workers
(`kody-pr-<n>-platform`, `kody-pr-<n>-runtime`, `kody-pr-<n>-jobs`), isolated
app/audit/jobs D1 resources, KV, mock workers, and a seeded login. The workflow
comments the URL on the PR. Details of resource names and cleanup live in
[`preview deploys`](./setup/preview-deploys.md).

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
`/admin` is expected to 403. Preview credentials are public, so the seed is
intentionally non-admin. States that only an admin can set (account suspension,
outbound-email pause, account deletion kickoff, fleet feature flags) cannot be
reproduced on preview. For those paths, sufficient evidence is the local admin
seed (`kody@example.com` / `ilikecode`) plus targeted Workers or unit tests —
not a preview `/admin` session and not raw D1 writes.

Do not seed preview D1 from the agent VM with `tools/ci/preview-resources.ts`
unless you are an operator with Cloudflare credentials. Create user data through
the product JSON APIs (`/account/*.json` in
`packages/worker/universal/routes.ts`) or, for a saved package,
`npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]`.
Those JSON endpoints are the same ones the UI posts to. Package creation is
MCP-only (`packageGetGitRemote({ create: true, kody_id })` with the package name
leaf or `@owner/leaf`); there is no create action on
`POST /account/packages.json`. Arbitrary MCP `execute` / `search` uses
`control-kody execute` / `search` against the same origin.

`/mcp` stays OAuth-protected; an unauthenticated GET is 401 by design. Logged-in
preview testing does not require agents to hand-roll an MCP OAuth dance — the
CLI does it for them.

Two `packageSave` packages on the seed account are both self-authored and share
implicit user-secret read. That is not a locked-secret denial test. To preview
the denial path, publish a listing, install or `communityFork` it under a
different `kody_id`, skip adoption (`community_forks.adopted_at` stays null),
lock the user secret to the original package, then run the fork. Workers
coverage in `package-secret-authority.workers.test.ts` is authoritative for the
denial path; see
[Package approval](../use/secrets-and-values.md#package-approval).

## Logged-in data and UI pass

1. Run the script with `--request` (and `--check` for HTML) covering the change.
2. If you need a longer session, keep using `control-kody request` (or more
   `--request` flags) against the same origin. Do not `cat` the cookie into
   `curl` or Python.
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
[`seeding`](./setup/seeding.md#reset-re-migrate-then-seed). The manual-test
script does not create or destroy Cloudflare resources.
