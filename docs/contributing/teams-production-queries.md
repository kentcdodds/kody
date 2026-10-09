# Teams production queries

Before the Teams data conversion (P8), five questions about production data must
be answered, because the preview rehearsal only has synthetic data. The queries
are read-only and return counts and ids only. Kent runs them, or approves
someone else running them.

## Run

From `main`, as `kentcdodds`:

```bash
node tools/preview-rehearsal/seal.ts keygen --private-key ~/.kody-queries/key > ~/.kody-queries/key.pub
gh workflow run teams-production-queries.yml --ref main -f target=production \
  -f recipient_public_key="$(cat ~/.kody-queries/key.pub)" \
  -f confirm="read-only production queries"
gh run download <run-id> -n teams-production-queries -D queries
node tools/preview-rehearsal/seal.ts open --private-key ~/.kody-queries/key --in queries/report.sealed.json --out queries/report.json
```

The workflow (`.github/workflows/teams-production-queries.yml`) refuses
production unless the actor is `kentcdodds`, the ref is `main`, and `confirm`
matches. To approve another runner, Kent adds their GitHub login to the
workflow's check step in a reviewed PR.

The report leaves CI only sealed to the recipient key, and the public run
summary has no counts: Actions artifacts and logs on this repo are
world-readable. Keep `report.json` off the repo.

Rehearse the same D1 and KV queries on a branch preview first with
`-f target=kody-branch-<slug>` (any dispatcher, no `confirm`). Previews have no
Stripe account, so that run reports Stripe as skipped.

## What it answers

| Spec §12.4 question                                | Source                                                                                                                     | Report field                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1. Every `account_type = 'platform'` row           | APP_DB `users`, with package counts and `package_scope_grants` grantees                                                    | `platformAccounts`               |
| 2. Platform packages depending on another platform | APP_DB `published_bundle_artifacts.dependencies_json` at each package's current published commit, owners from `users`      | `crossPlatformScopeDependencies` |
| 3. Guest packages importing a shared package       | The same dependency lists (`shareOwned`, or a person-owned dependency from another owner) joined to `package_share_grants` | `sharedPackageImports`           |
| 4. OAuth grants with and without `orgId`           | `OAUTH_KV` `grant:*` values: plaintext `metadata.orgId` only (props stay encrypted)                                        | `oauthGrants`                    |
| 5. Live Stripe subscriptions by price id           | Stripe `GET /v1/subscriptions?status=all`, excluding `canceled` and `incomplete_expired`                                   | `stripeSubscriptions`            |

Stripe prices are classified with the worker's own billing config
(`packages/worker/src/billing/billing-config.ts` and the production
`STRIPE_PRO_*` vars in `packages/worker/wrangler.jsonc`) as `purchasable-pro`,
`retired-standard`, `retired-pro`, or `unmapped`. Any `unmapped` subscription
means the §7.2 seat mapping does not cover it yet.

Dependencies recorded before the field existed have no `packageId`; questions 2
and 3 follow `sourceId` to `entity_sources`, so they still resolve. Artifacts
from older published commits are not current imports and are ignored.

## Read-only guarantees

- D1 goes through `assertReadOnlySql`: a single `SELECT` or `WITH` statement, no
  comments, and no write keyword anywhere (a false positive fails the run). The
  CI token can write, so this check is what keeps the run read-only.
- KV is read with list and bulk get. Stripe is read with `GET` only.
- Code and tests: `tools/teams-migration/production-queries.ts` and
  `production-queries.node.test.ts`. The tests run each query against a fully
  migrated APP_DB schema.

Related: [preview migration rehearsal](./preview-migration-rehearsal.md).
