# Invocation-token retirement runbook

Executable plan for draining HTTP package invocation tokens after inbound
webhooks cover the invoke jobs (ADR
[0048](../decisions/0048-webhooks-replace-invocation-tokens.md)). Modeled on the
[values retirement runbook](./values-retirement-runbook.md).

## Status

Webhooks accept caller `Idempotency-Key`, `inputMode: "params"`, and a
per-declaration `rateLimitPerMinute` (default 60, max 600). Token UI, MCP
`packageGet.tokens`, token setup URLs, and the
`POST /@:user/api/package-invocations/…` path still exist. Do not send fleet
email from this runbook.

This change does **not** drop token tables.

## Destination map

| Job                                      | Destination                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Vendor POST (Sentry, GitHub, Stripe)     | Inbound webhooks, `inputMode: "request"`, optional HMAC + `replay`                                         |
| First-party trusted client (gateway/CLI) | Inbound webhooks, `inputMode: "params"`, `Idempotency-Key`, `sync` or `ack`, one webhook per export        |
| Multi-export / `*` token                 | One webhook declaration per export the client actually calls — no wildcard URL                             |
| Author composition                       | Static `import` / `import(specifier)` / workflows ([0037](../decisions/0037-no-author-packages-invoke.md)) |

Known first-party callers to migrate (operator account; follow-up, not this
change):

- `@kentcdodds/discord` — `./dispatch-message-created`,
  `./dispatch-message-reaction-add`
- `@kentcdodds/youtube-livestream-vod-manager` — `./process-video`
- `@kentcdodds/bluesky` and `@kentcdodds/linkedin` — create/delete/get exports
- `@kentcdodds/weekly-site-perf` — root `.` export
- `@kentcdodds/raycast` — one webhook per export the extension calls (not `*`)

## Remaining work

1. Migrate the live invoke-token callers above to minted webhook URLs.
2. Unadvertise tokens: remove token UI, MCP guides, `packageGet.tokens`, and
   setup URLs after the soak (follow-up PR).
3. Keep the HTTP token path as an unadvertised drain until leftover rows are 0.
4. Drop `package_invocation_tokens` (and related columns) only after the count
   below is 0. Do not drop tables in the same deploy that first hides the UI.

Re-query leftover counts before the unadvertise PR and again before the
table-drop PR:

```sql
SELECT
	(SELECT COUNT(*) FROM package_invocation_tokens WHERE revoked_at IS NULL) AS active_tokens,
	(SELECT COUNT(*) FROM package_invocation_tokens) AS token_rows,
	(SELECT COUNT(DISTINCT user_id) FROM package_invocation_tokens) AS users_with_tokens;
```

Confirm the table name against current migrations before running this in
production.

## What not to do

- Do not add `*` webhook URLs or a multi-export ingress path.
- Do not keep tokens because webhooks exist. Webhooks are the knock.
- Do not delete token tables in the capability PR.
- Do not send user email as part of the drain.
- Do not change the internal `invokePackageExport` host path webhooks already
  use (synthetic token, `source: 'webhook'`).

## Related

- [0048 — Inbound HTTP is webhooks; invocation tokens drain](../decisions/0048-webhooks-replace-invocation-tokens.md)
- [0037 — No author-facing `packages.invoke`](../decisions/0037-no-author-packages-invoke.md)
- [0026 — Package-owned invocation tokens](../decisions/0026-package-owned-invocation-tokens.md)
- [Inbound webhooks](./webhooks.md)
- [Cleanup after migrations](../cleanup-after-migrations.md)
