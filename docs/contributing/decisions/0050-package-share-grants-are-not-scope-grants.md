# 0050: Package share grants are not platform scope grants

- **Status:** accepted
- **Date:** 2026-09-10

## Context

`package_scope_grants` / `adminPackageScopeGrant*` grant a person **full
authoring** inside a **platform** account scope. That table is admin-minted,
platform-owner only, and the seed of a future org/teams feature. See
[platform accounts](../architecture/platform-accounts.md).

Person-to-person sharing (spouse, staff, a collaborator who should **use** a
package without a shared login) is a different product. Reusing scope grants
would let a person account become a scope owner, or would give a guest write and
publish on someone else's package.

Grant-level `pin` / `follow` is publish trust on an accepted share. It is not a
user-facing import specifier pin ([0001](./0001-no-package-versioning.md)).

## Decision

Do not put person accounts on `package_scope_grants`. Person-to-person sharing
uses `package_share_grants`: owner-only invite, accept required, v1 role `use`
(read source + invoke), paid-plan gates, pin/follow publish trust, and
stamp-aligned isolation so shared code does not receive the guest's other
secrets.

## Consequences

Scope grants stay platform-admin authoring. Share grants stay per-package use
invitations. Collaborator / write roles can extend share-grant RBAC later
without opening person accounts as scope owners.

**Revisit-if** orgs need a single membership table that covers both platform
scopes and person-owned packages, and share-grant RBAC is no longer enough.
