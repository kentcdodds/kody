# Teams production queries

The workflow seals two read-only reports. `report.sealed.json` counts OAuth
grants (with and without `orgId`) and live Stripe subscriptions.
`credential-exposure.sealed.json` counts multi-member orgs, outside grants, and
non-owner / non-granted secret or integration audit rows. Counts and ids only.
Production runs are `kentcdodds` or the approved Cloud Agent actor (`cursor`).

The pre-conversion questions that read `package_share_grants`,
`package_scope_grants`, or `users.account_type = 'platform'` are gone. Those
tables and the column were dropped in the Teams P9 contract migrations.

## Run

From `main`, as an approved actor (`kentcdodds` or `cursor`):

```bash
mkdir -p ~/.kody-queries
node tools/preview-rehearsal/seal.ts keygen --private-key ~/.kody-queries/key > ~/.kody-queries/key.pub
gh workflow run teams-production-queries.yml --ref main -f target=production \
  -f recipient_public_key="$(cat ~/.kody-queries/key.pub)" \
  -f confirm="read-only production queries"
gh run download <run-id> -n teams-production-queries -D queries
node tools/preview-rehearsal/seal.ts open --private-key ~/.kody-queries/key --in queries/report.sealed.json --out queries/report.json
node tools/preview-rehearsal/seal.ts open --private-key ~/.kody-queries/key --in queries/credential-exposure.sealed.json --out queries/credential-exposure.json
```

The workflow (`.github/workflows/teams-production-queries.yml`) runs only from
`main`, because the CI Cloudflare token reaches production for every target. It
refuses production unless the actor is `kentcdodds` or `cursor` and `confirm`
matches. To approve another runner, add their GitHub login to the workflow's
check step in a reviewed PR.

The report leaves CI only sealed to the recipient key, and the public run
summary has no counts: Actions artifacts and logs on this repo are
world-readable. Keep opened JSON off the repo.

Production Stripe counts use the Actions secret `STRIPE_SECRET_KEY` on
production-only steps (repository or the `production` environment). A job-level
`condition && secrets.X || ''` expression can evaluate empty for environment
secrets, and a job-level assignment would also expose the key on preview
targets. A Worker-only key is not enough — production deploy syncs Stripe as
optional. When the secret is empty or whitespace, Stripe counts are skipped with
a warning and the sealed report records `stripeSubscriptions.skipped`; the OAuth
KV query and credential-exposure still run. The OAuth KV namespace is found by
title: `kody-oauth` in production, resolved from the Wrangler worker name the
same way `node tools/ci/production-resources.ts ensure` creates it.

Rehearse the same queries on a branch preview first with
`-f target=kody-branch-<slug>` (from `main`, any dispatcher, no `confirm`).
Previews have no Stripe account, so that run reports Stripe as skipped.

## What it answers

| Question                              | Source                                                                                                                               | Report field                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| OAuth grants with and without `orgId` | `OAUTH_KV` `grant:*` values: plaintext `metadata.orgId` only (props stay encrypted)                                                  | `oauthGrants`                     |
| Live Stripe subscriptions by price id | Stripe `GET /v1/subscriptions?status=all`, excluding `canceled` and `incomplete_expired`. Skipped when `STRIPE_SECRET_KEY` is unset. | `stripeSubscriptions`             |
| Credential exposure surface           | APP_DB multi-member orgs + outside grants; AUDIT_DB secret/integration rows filtered in JS                                           | `credential-exposure.sealed.json` |

Stripe prices are classified with the worker's own billing config
(`packages/worker/src/billing/billing-config.ts` and the production
`STRIPE_PRO_*` vars in `packages/worker/wrangler.jsonc`) as `purchasable-pro`,
`retired-standard`, `retired-pro`, or `unmapped`. Any `unmapped` subscription
means the §7.2 seat mapping does not cover it yet.

`report.sealed.json` is version 2: `oauthGrants` and `stripeSubscriptions` only.

### Credential exposure report

`credential-exposure.sealed.json` answers:

| Question                                                                   | Source                                                                                              | Report field                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Orgs with more than one live member, or any outside grant                  | APP_DB `orgs` / `org_memberships` / `grants`                                                        | `orgsWithExposureSurface`          |
| Multi-member org rows                                                      | APP_DB                                                                                              | `multiMemberOrgs`                  |
| Outside grants (subject not a live member)                                 | APP_DB `grants`                                                                                     | `outsideGrants`                    |
| Secret / integration (MCP) audit where actor ≠ owner and ≠ granted subject | AUDIT_DB `org_audit_events` + APP_DB owners / grants / `team_members` (JS filter; DBs are separate) | `nonOwnerOrGrantedCredentialAudit` |

Ambient placeholder expansion did not write `org_audit_events` historically, so
the audit section is a capability-surface check when rows exist. MCP servers
authorize as `integration` resources. Saved packages keep implicit self-authored
credential access for now; the credentials redesign series removes it. The full
`resolveCredential(orgId, actor, packageStamp?)` choke point is the first PR of
that series (not a separate GitHub issue).

## Read-only guarantees

- Credential-exposure D1 goes through `assertReadOnlySql`: a single `SELECT` or
  `WITH` statement, no comments, and no write keyword anywhere (a false positive
  fails the run). The CI token can write, so this check is what keeps the run
  read-only. The OAuth/Stripe script does not query D1.
- KV is read with list and bulk get. Stripe is read with `GET` only.
- Code and tests: `tools/teams-migration/production-queries.ts`,
  `credential-exposure-queries.ts`, and their `*.node.test.ts` files.
  Credential-exposure tests run each query against a fully migrated APP_DB
  schema.

Related: [preview migration rehearsal](./preview-migration-rehearsal.md).
