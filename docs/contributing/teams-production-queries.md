# Teams production queries

Before the Teams data conversion (P8), five questions about production data must
be answered, because the preview rehearsal only has synthetic data. The same
workflow also seals a credential-exposure report (multi-member orgs, outside
grants, and non-owner / non-granted secret or integration audit rows). The
queries are read-only and return counts and ids only. Production runs are
`kentcdodds` or the approved Cloud Agent actor (`cursor`).

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
optional. When the secret is empty or whitespace, question 5 is skipped with a
warning and the sealed report records `stripeSubscriptions.skipped`; D1/KV
queries and credential-exposure still run. The OAuth KV namespace is found by
title: `kody-oauth` in production, resolved from the Wrangler worker name the
same way `node tools/ci/production-resources.ts ensure` creates it.

Rehearse the same D1 and KV queries on a branch preview first with
`-f target=kody-branch-<slug>` (from `main`, any dispatcher, no `confirm`).
Previews have no Stripe account, so that run reports Stripe as skipped.

## What it answers

| Spec §12.4 question                                | Source                                                                                                                               | Report field                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 1. Every `account_type = 'platform'` row           | APP_DB `users`, with package counts and `package_scope_grants` grantees                                                              | `platformAccounts`                |
| 2. Platform packages depending on another platform | APP_DB `published_bundle_artifacts.dependencies_json` at each package's current published commit, owners from `users`                | `crossPlatformScopeDependencies`  |
| 3. Guest packages importing a shared package       | The same dependency lists (`shareOwned`, or a person-owned dependency from another owner) joined to `package_share_grants`           | `sharedPackageImports`            |
| 4. OAuth grants with and without `orgId`           | `OAUTH_KV` `grant:*` values: plaintext `metadata.orgId` only (props stay encrypted)                                                  | `oauthGrants`                     |
| 5. Live Stripe subscriptions by price id           | Stripe `GET /v1/subscriptions?status=all`, excluding `canceled` and `incomplete_expired`. Skipped when `STRIPE_SECRET_KEY` is unset. | `stripeSubscriptions`             |
| Credential exposure surface                        | APP_DB multi-member orgs + outside grants; AUDIT_DB secret/integration rows filtered in JS                                           | `credential-exposure.sealed.json` |

Stripe prices are classified with the worker's own billing config
(`packages/worker/src/billing/billing-config.ts` and the production
`STRIPE_PRO_*` vars in `packages/worker/wrangler.jsonc`) as `purchasable-pro`,
`retired-standard`, `retired-pro`, or `unmapped`. Any `unmapped` subscription
means the §7.2 seat mapping does not cover it yet.

Dependencies recorded before the field existed have no `packageId`; questions 2
and 3 follow `sourceId` to `entity_sources`, so they still resolve. Artifacts
from older published commits are not current imports and are ignored.

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

- D1 goes through `assertReadOnlySql`: a single `SELECT` or `WITH` statement, no
  comments, and no write keyword anywhere (a false positive fails the run). The
  CI token can write, so this check is what keeps the run read-only.
- KV is read with list and bulk get. Stripe is read with `GET` only.
- Code and tests: `tools/teams-migration/production-queries.ts`,
  `credential-exposure-queries.ts`, and their `*.node.test.ts` files. The tests
  run each query against a fully migrated APP_DB schema.

Related: [preview migration rehearsal](./preview-migration-rehearsal.md),
including the P8 backup and verify workflow.
