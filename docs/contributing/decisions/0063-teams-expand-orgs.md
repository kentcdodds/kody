# 0063 — Teams P3 expand adds org rows without moving storage keys

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Teams phase 3 (**expand**) introduces `orgs`, `org_memberships`, and `handles`
in APP_DB while every existing resource keeps its current owner id. Personal
orgs reuse `users.stable_user_id` as `orgs.id`, so Durable Object names, KV/R2
keys, and D1 `user_id` columns do not re-key. Billing and profile columns are
copied onto org rows; `users` columns stay until a later contract change.
Soft-delete columns land additively; enforced read filters are phase 7.

## Decision

- **Migrated and new personal orgs** use `orgs.id = stable_user_id`. New signups
  provision org + owner membership + handle in the same flow as user creation.
- **Request context** loads org binding from D1 where the session/MCP OAuth path
  has APP_DB (`loadOrgBindingForPerson`). Sync call sites without DB still use
  `resolveOrgBinding` → `personalOrgId` until phase 4 passes `orgBinding`
  everywhere.
- **Entitlements** read billing columns from `orgs` first, with a logged
  fallback to `users` if a row is missing. Writes that change plan, Stripe, or
  related entitlement columns dual-write to `orgs` with the same id.
- **Handles** share the username namespace: personal org slugs are immutable on
  rename; the live username moves to a new handle row while the original handle
  keeps `org_id` for the org slug.
- **Org audit** (`org_audit_events` in AUDIT_DB) is separate from platform
  `audit_events`. Backfill records `org.migrated` per org.

Storage reads and usage billing that have an org on the request use
`ownerIdFromCaller` (`request.org.id`). Packages and connected agents on org
section pages still read the person. We do **not** yet filter every soft-deleted
org row on reads, or drop legacy `users` billing columns.

## Consequences

[ADR 0060](./0060-owner-and-person-ids.md) still governs id types; org
membership is now the DB-backed source for “which org” on interactive paths,
while `personalOrgId` remains the sync fallback. Follow-up phases wire team
grants, org switching, storage key migration, and soft-delete enforcement.

`org.migrated` rows are an operator command, not a deploy step.
`backfillOrgMigratedAuditEvents` writes one success row per org, and a repeat
inserts nothing new. The command and the `workflow_dispatch` workflow are
documented in
[Teams org.migrated audit backfill](../teams-org-migrated-audit-backfill.md).
