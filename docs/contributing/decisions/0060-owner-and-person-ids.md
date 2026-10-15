# 0060 — Owner ids and person ids are separate types; storage stays keyed as-is

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Every Kody surface used one string, `users.stable_user_id`, for two jobs: whose
data an operation touches (D1 `user_id` columns, Durable Object names, Vectorize
namespaces, R2/KV key prefixes, secret AAD) and who is acting (sessions,
passkeys, OAuth/CLI/API-token principals, audit, RBAC). Orgs own resources.
Legacy personal orgs reuse `stable_user_id` as `orgs.id` (no data move);
[ADR 0063](./0063-teams-expand-orgs.md) #3053 phase 2+ mints a distinct
`orgs.id` for new personal orgs and records it on `users.personal_org_id`.
Stable ids are opaque: new accounts get 32 random bytes, and legacy accounts may
hold SHA-256(email), so ids are never public.

## Decision

`@kody-internal/shared/owner-person-ids.ts` defines two branded types. Mixing
them is a compile error.

- `OwnerId` is the id of the org that owns a resource, and is used for storage.
- `PersonId` is the acting person, and is used for audit, RBAC, and attribution.

`personalOrgId(person)` brands a person id into `OwnerId` for **person-keyed**
storage only. Personal org resolution reads `users.personal_org_id` (see
[ADR 0063](./0063-teams-expand-orgs.md) #3053 phase 3). Acting in any other org
must go through an explicit membership or grant check.
`resolvePackageOwnerContext` (platform scope grants) and
`resolvePackageStorageOwner` (share grants) are the two existing checks. Caller
contexts carry both ids, derived when constructed and never serialized:
`McpCallerContext.request` and `AuthenticatedAppUser.request` hold `org.id` and
`actor.userId` (amended by [ADR 0061](./0061-one-request-context.md), which
replaced the separate `actor` and `owner` fields).

We do **not**:

- add `orgs`, `org_memberships`, roles, or org switching yet
- rename D1 columns: TEXT `user_id` columns hold an `OwnerId`
- change any Durable Object name, KV/R2 key, Vectorize namespace, or secret AAD
  string (`owner-storage-formats.node.test.ts` pins them)
- persist the request context in job caller contexts

## Consequences

New code reads the right id from the context, and the compiler rejects a person
id where an owner id belongs. The user-scoped Durable Object name builders,
their client wrappers, secret AAD builders, and the pinned R2, KV, and Vectorize
key builders take `OwnerId`. Callers pass `request.org.id` or an id already
branded at the storage read. Those builders do not call `ownerIdFromStored`, and
RunLog, UserMeter, Mailbox, RepoSessionIndex, and JobManager names stay the
stored bytes (untrimmed). Person→owner branding for person-keyed slots uses
`personalOrgId`; personal org ids come from `users.personal_org_id` /
`request.org.id`. Org membership is the other resolver (see
[ADR 0063](./0063-teams-expand-orgs.md)).
