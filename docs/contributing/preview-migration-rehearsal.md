# Preview migration rehearsal

A data migration (for example the Teams expand phase) must pass a rehearsal on a
dedicated **branch preview** before it runs in production. Rehearsal tooling is
`workflow_dispatch` only and runs with the CI Cloudflare token, so agents never
hold Cloudflare or site-admin credentials.

Everything here runs on `kody-branch-<slug>` previews only. PR previews redeploy
and reseed on every push; the scripts and workflow refuse them.

## The run, in order

Operators run these from a checkout of `main` with `gh` authenticated (agents
dispatch the same workflows through the `@kentcdodds/github` Kody package as
kody-bot, or ask an operator). `P` is the preview worker name.

```bash
P=kody-branch-teams-rehearsal

# 1. Create the preview from main (own app/audit/jobs D1, Vectorize index, KV).
gh workflow run preview.yml --ref main -f action=deploy -f target=branch -f preview_name=teams-rehearsal

# 2. Make a key pair for sealed credentials (keep the private key off the repo).
node tools/preview-rehearsal/seal.ts keygen --private-key ~/.kody-rehearsal/key > ~/.kody-rehearsal/key.pub

# 3. Seed (takes a pre-seed D1 bookmark first). Safe to re-run: a complete
#    roster is a no-op and does not overwrite the pre-seed bookmark.
gh workflow run preview-rehearsal.yml -f preview_name=$P -f action=seed -f recipient_public_key="$(cat ~/.kody-rehearsal/key.pub)"

# 4. Snapshot before the migration. Note the run id: it is the restore point.
gh workflow run preview-rehearsal.yml -f preview_name=$P -f action=snapshot

# 5. Run the migration: deploy the migration branch to the same preview
#    (migrations apply first), then rebuild the preview's Vectorize index.
gh workflow run preview.yml --ref <migration-branch> -f action=deploy -f target=branch -f preview_name=teams-rehearsal
gh workflow run preview-rehearsal.yml -f preview_name=$P -f action=reindex

# 6. Verify: snapshot again, then diff against step 4.
gh workflow run preview-rehearsal.yml -f preview_name=$P -f action=snapshot
gh run download <before-run-id> -n preview-rehearsal-snapshot -D before
gh run download <after-run-id> -n preview-rehearsal-snapshot -D after
node tools/preview-rehearsal/run.ts diff --before before/json-snapshot.json --after after/json-snapshot.json
node tools/preview-rehearsal/run.ts diff --before before/d1-snapshot.json --after after/d1-snapshot.json

# 7. Rehearse rollback: restore the step 4 bookmarks.
gh workflow run preview-rehearsal.yml -f preview_name=$P -f action=restore -f snapshot_run_id=<before-run-id> -f confirm=$P
```

Attach the run links and both diffs to the migration PR. `diff` exits 1 when
anything differs; each difference must be expected by the migration (new tables,
rewritten scopes) or it is a bug.

The D1 diff always has some noise. Every bookmark changes. Each JSON snapshot
also writes a fixed set of rows: about 21 `audit_events` (five logins, five MCP
authorizations, and 11 audited admin reads) and 4
`agent_package_conversation_uses` (one per non-admin user's package execute).
Restore rewinds data only, so after a restore the JSON diff still shows whatever
the deployed code changed.

Keep the preview quiet while this runs: one step at a time, no other deploys to
it, and no manual sign-ins during a `snapshot` or `restore`. The workflow runs
one action at a time per preview, but it does not lock against `preview.yml`.
The D1 bookmarks are taken one database after another, so a write landing
between them makes the restore point inconsistent.

## Workflow actions

`.github/workflows/preview-rehearsal.yml` (`🧪 Preview Rehearsal`). Each run
uploads `preview-rehearsal-<action>` and writes the D1 table to the run summary.

| Action        | Does                                                                                                                          | Inputs                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `seed`        | Empty roster: pre-seed D1 bookmark, then the §12.2 dataset. Complete roster: no-op (no new bookmark). Partial roster: fail.   | `recipient_public_key`                      |
| `snapshot`    | JSON snapshot as every rehearsal user, then D1 bookmark + row counts per table (APP_DB, AUDIT_DB, JOBS_DB)                    | —                                           |
| `reindex`     | Rotates the app worker's `CAPABILITY_REINDEX_SECRET` and runs a full `--force` sweep (capabilities, memories, jobs, packages) | —                                           |
| `credentials` | Mints one CLI token per rehearsal user with an explicit lifetime; uploads them sealed                                         | `recipient_public_key`, `token_lifetime`    |
| `restore`     | D1 Time Travel restore of APP_DB, AUDIT_DB, and JOBS_DB to the bookmarks in another run's `d1-snapshot.json`                  | `snapshot_run_id`, `confirm` = preview name |

A `seed` run's artifact holds the **pre-seed** bookmarks only when the roster
was empty. A failed mid-seed is retried by restoring that run and seeding again.
A second `seed` is a no-op only when the full roster exists **and** dave has
been renamed to `rh-dave-renamed` (the last durable APP_DB write). Six accounts
without that rename is still partial. A no-op does not take a new bookmark, so
it cannot overwrite the real pre-seed snapshot. A partial roster still fails —
restore the last successful seed run, then seed again. The `seed` command itself
still refuses to write into a non-empty roster.

<details>
<summary>What the seed creates (§12.2)</summary>

| Who           | How                                                                       | Holds                                                                   |
| ------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `rh-admin`    | Seed SQL path (`buildSeedUserSql`, legacy `sha256(email)` id), site admin | Runs every admin step                                                   |
| `rh-alice`    | Seed SQL path (legacy id), Pro                                            | Shared package (accepted by carol), $25 grant                           |
| `rh-bob`      | Seed SQL path (legacy id)                                                 | Scope grant on `@rh-platform`; published there                          |
| `rh-carol`    | `adminUserCreate` + setup link (random id), Pro                           | Accepted alice's share and ran it; pending invite to alice; auto-refill |
| `rh-dave`     | `/auth` signup + `adminUserVerify` (random id)                            | Forked the platform listing; renamed to `rh-dave-renamed`               |
| `rh-platform` | `adminPlatformAccountCreate`                                              | Public (listed), private, and hidden packages                           |

Each of alice, bob, carol, and dave has: a package with an inline app, a
recurring and a one-off job (the recurring one run once), a webhook with a
minted URL, a package-scoped and a user-level secret (each approved for the mock
echo host, with a decryption proof checked during seed), a connected OAuth
integration against the preview's mock token endpoint, four memories, an MCP
OAuth connection, a CLI bootstrap token, and an API token with every scope.
Usage comes from the seed's own execute and job runs.

Writes go through the product: MCP `execute` and the session JSON routes the UI
posts to. The only direct D1 writes are the seed-path users (the same SQL as
`tools/seed-test-data.ts`) and carol's auto-refill settings, because previews
have no Stripe mock and the settings route requires a Stripe customer.

</details>

<details>
<summary>What a snapshot records (§12.2 step 3)</summary>

Per user, signed in as that user: ids and username, packages, the inline app
response, jobs with `next_run_at`, webhooks, secret names plus a fresh
decryption proof for both secrets, integrations plus an authenticated call, top
results for four fixed memory searches, share grants (inbound and outbound;
alice and carol, the users who opted in to sharing), token ids and scopes, and
usage. As the admin: each user's account record and wallet (balance, plan,
eligibility), and the scope grants.

Every read is a required check. A failed check is written into the snapshot and
listed under `failures`, and the run fails, so a check that breaks the same way
before and after still fails the rehearsal. Usage counters sit under `observed`,
which `diff` skips: each snapshot's own execute calls, and job runs, move them.

Then per D1 database: a Time Travel bookmark and the row count of every table.
The JSON snapshot runs first, so the bookmark includes the audit events and
usage the snapshot itself created.

The preview fixture user (`me@kentcdodds.com`) is not in the JSON snapshot.
`preview.yml` re-runs its seed on every deploy, but that seed is idempotent
upserts, so table counts stay stable across deploys.

</details>

## Credentials

The rehearsal admin and users have private passwords: HMAC-SHA256 of the preview
name and role under the CI Cloudflare token
(`tools/preview-rehearsal/rehearsal-env.ts`). Nothing is stored; every workflow
run derives the same passwords, masks them, and never prints them. Rotating that
token changes every derived password, so the workflow can no longer sign in to
previews seeded before the rotation; re-create those previews and seed again.
Credentials leave CI only as an envelope sealed to your public key (RSA-OAEP-256
wrapping an AES-256-GCM key), because Actions artifacts on this public repo are
world-readable.

Open a sealed artifact locally:

```bash
gh run download <run-id> -n preview-rehearsal-credentials -D creds
node tools/preview-rehearsal/seal.ts open --private-key ~/.kody-rehearsal/key --in creds/credentials.sealed.json --out creds/credentials.json
```

`credentials.json` has, per user, `email`, `password`, and `token` (seed
artifacts carry `cliToken` and `everyScopeToken` instead), plus `origins.app`,
`origins.api`, and `origins.mockCloudflare`. Keep it mode 600 and out of the
repo.

### Headless multi-user CLI

Each user gets its own CLI identity. Pass the token per process, and point the
CLI at the preview's API worker:

```bash
API="$(jq -r .origins.api creds/credentials.json)"
ALICE="$(jq -r '.users[] | select(.role == "alice") | .token' creds/credentials.json)"
KODY_API_TOKEN="$ALICE" npx @kodycodes/cli whoami --api-url "$API"
KODY_API_TOKEN="$ALICE" npx @kodycodes/cli execute --api-url "$API" --code 'import { kody } from "kody:runtime"; export default () => kody.packageList({})'
```

To store tokens instead (`kody auth bootstrap`), give every user its own config
directory; the CLI keys stored tokens by API host, so two users on one preview
would otherwise overwrite each other:

```bash
XDG_CONFIG_HOME="$PWD/.rehearsal/alice" npx @kodycodes/cli auth bootstrap --code <kody_bc_…> --lifetime short --api-url "$API"
XDG_CONFIG_HOME="$PWD/.rehearsal/alice" npx @kodycodes/cli execute --api-url "$API" --code '…'
```

A bootstrap code comes from `cliCredentialBootstrap` as that user. The lifetime
is always explicit: `short` (1h idle, 24h max), `long` (14d idle, 3mo max), or
both `--idle-ttl-seconds` and `--max-lifetime-seconds`.

An operator can also take the JSON snapshot without Cloudflare credentials:
`node tools/preview-rehearsal/run.ts json-snapshot --credentials creds/credentials.json --out snap.json`.

## P8: sharing and platform conversion

The Teams P8 data conversion is migration
`packages/worker/migrations/0091-teams-sharing-platform-conversion.sql`, so it
runs in step 5 with the rest of the migrations. It turns accepted package shares
into `use` grants, pending shares into grant invites (fresh tokens, so old share
invite links stop working), scope grantees into Owners, and platform accounts
into `pro` orgs with admin credits. Only `@kody` gets the $1,000 site-admin
credit. Revoked and left shares stay for the P9 table drop. The migration fails
closed on those invariants.

`.github/workflows/teams-p8-conversion.yml` (`🔁 Teams P8 Conversion Checks`)
adds a sealed backup and a read-only verify around that migration. Both seal to
your recipient key, and the public logs name failing checks without counts:

```bash
# Before the migration deploys: seal share grants, scope grants, and platform users rows.
gh workflow run teams-p8-conversion.yml --ref main -f target=$P -f mode=backup \
  -f recipient_public_key="$(cat ~/.kody-rehearsal/key.pub)"

# After it deploys: re-check every invariant. Fails when any check has gaps.
gh workflow run teams-p8-conversion.yml --ref main -f target=$P -f mode=verify \
  -f recipient_public_key="$(cat ~/.kody-rehearsal/key.pub)"
```

A branch preview already has the migration applied after step 5, so
`mode=backup-then-verify` runs both there. Production needs
`-f target=production -f confirm="teams p8 conversion checks"`, `main`, and
`kentcdodds`. `verify` is meant for right after the deploy: it expects the
converted state, so a later change (an Owner removed on purpose) shows as a gap.

When `verify` names a gap in memberships, platform plans, or the `@kody` credit,
`node tools/teams-migration/convert-sharing-and-platform.ts --mode repair --confirm-repair ...`
re-applies those writes (idempotent) and verifies again. Lost share grants are
not repaired there: restore from the D1 bookmark and re-apply the migration.
Code and tests: `tools/teams-migration/convert-sharing-and-platform.ts` and
`convert-sharing-and-platform.node.test.ts`.

## What the preview cannot rehearse

| Gap                                                                      | Covered by                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Inbound email (no `USER_EMAIL_DOMAIN`, no inbound route on previews)     | Workers tests of the `email()` handler                                                                             |
| Package-app subdomains and cookie binding (`PACKAGE_APP_BASE_URL` unset) | Workers tests, plus a production smoke after cutover; previews rehearse the inline app path                        |
| Seat subscriptions and Stripe-backed auto-refill                         | Workers tests with a stubbed Stripe client; the seed writes auto-refill settings directly                          |
| Plaintext secret reveal                                                  | Does not exist; decryption is proven by hashes from the mock echo route                                            |
| Production data shapes                                                   | [Teams production queries](./teams-production-queries.md) (spec §12.4)                                             |
| Rolling back KV, Durable Objects, Artifacts repos, or Vectorize          | Not covered: `restore` rewinds D1 only; run `reindex` after a restore, and re-create the preview for a clean slate |

## Reference

- Scripts: `tools/preview-rehearsal/run.ts` (`--help` via no arguments),
  `seal.ts`, `seed.ts`, `json-snapshot.ts`, `d1-rehearsal.ts`.
- Mock routes: `/__mocks/rehearsal/echo` (SHA-256 of `x-rehearsal-secret` and
  `Authorization`) and `/__mocks/rehearsal/oauth/token`, on the preview's
  `-mock-cloudflare` worker
  (`packages/mock-servers/cloudflare/src/rehearsal-routes.ts`).
- Preview resources and isolation:
  [preview deploys](./setup/preview-deploys.md).
- Everyday preview testing (public non-admin seed):
  [manual preview testing](./preview-manual-testing.md).
