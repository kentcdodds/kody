# 0060 — Owner ids and person ids are separate types; storage stays keyed as-is

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Every Kody surface used one string, `users.stable_user_id`, for two jobs: whose
data an operation touches (D1 `user_id` columns, Durable Object names, Vectorize
namespaces, R2/KV key prefixes, secret AAD) and who is acting (sessions,
passkeys, OAuth/CLI/API-token principals, audit, RBAC). Orgs will own resources:
a user's **personal org** reuses their existing `stable_user_id` as its org id,
so no data moves, and every other org gets a separately minted random id. The
future tables are `orgs` and `org_memberships`. Stable ids are opaque: new
accounts get 32 random bytes, and legacy accounts may hold SHA-256(email), so
ids are never public.

## Decision

`@kody-internal/shared/owner-person-ids.ts` defines two branded types. Mixing
them is a compile error.

- `OwnerId` is the id of the org that owns a resource, and is used for storage.
- `PersonId` is the acting person, and is used for audit, RBAC, and attribution.

`personalOrgId(person)` is the only conversion between the two. Today it is the
identity function. Acting in any other org must go through an explicit
membership or grant check, never through this function.
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
id where an owner id belongs. Many storage helpers still take a plain `string`.
Typing them as `OwnerId` happens incrementally, at the caller boundary, and
never by re-keying. Revisit when `orgs` lands: `personalOrgId` stays for
personal orgs, and org membership becomes the second resolver (see
[ADR 0063](./0063-teams-expand-orgs.md) for the P3 expand landing).
