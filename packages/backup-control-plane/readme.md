# Production D1 backup control plane

This package is a dedicated scheduled Worker and Workflow. It is intentionally
separate from application cron and does not use `DynamicCallableWorkflow`.

## Retention prefixes

The schedule and key policy use UTC exclusively:

- Sunday UTC backups use `weekly/d1/<database-uuid>/<yyyy-mm-dd>/...` and the
  manifest retention tier `weekly`.
- All other UTC weekdays use `daily/d1/<database-uuid>/<yyyy-mm-dd>/...` and
  retention tier `daily`.

Configure the production R2 bucket lifecycle by these immutable prefixes:

- `daily/`: expire after approximately 35 days.
- `weekly/`: expire after approximately 400 days.

R2 lifecycle rules are bucket configuration and are deliberately not encoded as
application deletion logic. Before deployment, replace every placeholder in
`wrangler.jsonc`, create those lifecycle rules, provide the API token as a
secret, and set both enable variables to exactly `true` only after the export
benchmark is approved.

Workflow instance retention is omitted intentionally so Cloudflare applies the
maximum available to the account (currently up to 30 days on paid plans and
three days on free plans). This is separate from R2 backup retention.

## Integrity checks

The hourly freshness check compares the immutable object's R2 size and ETag to
the canonical manifest. Run a separate periodic restore drill that downloads the
object, verifies its SHA-256 against the manifest, and restores it into a
non-production D1 database. The metadata freshness check is not a replacement
for that deep checksum and restore drill.
