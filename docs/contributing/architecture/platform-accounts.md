# Platform accounts and package scope grants

Kody distinguishes **person accounts** (normal signups) from **platform
accounts** (operator-provisioned owners of official package scopes such as
`@kody`). Platform accounts never log in and have no usable password. Person
users continue to own their personal package scope by default; an explicit
**package scope grant** lets a person act inside a platform account's scope
while storage remains scoped to exactly one owner `userId`.

See [Data storage](./data-storage.md) for table inventory and
[Authorization](./authorization.md) for admin capability guards.

## Data model

Migration `packages/worker/migrations/0072-package-scope-grants.sql`:

- **`users.account_type`** — `'person'` (default) or `'platform'`. Platform
  accounts are created by operators, not through signup.
- **`package_scope_grants`** —
  `(scope_owner_user_id, grantee_user_id, created_by_user_id, created_at)`.
  Primary key `(scope_owner_user_id, grantee_user_id)`. A row means the grantee
  person may act inside the scope owner's package namespace.

Platform account usernames must come from the reserved-username denylist in
`packages/worker/src/identity/reserved-usernames.ts` (for example `kody`,
`support`, `admin`). That list blocks end-user signup from claiming those names,
so platform scopes never collide with real accounts.

Platform accounts use a sentinel password hash that never verifies, the same
pattern as admin-created person accounts awaiting password setup.

## Actor / owner resolution

Package and community capabilities accept an optional `package_scope` input (for
example `"kody"`, without `@`). When omitted, or when it matches the caller's
own username, behavior is unchanged: the caller is both actor and owner.

When a foreign scope is requested, `resolvePackageOwnerContext` in
`packages/worker/src/package-registry/package-owner.ts` returns:

| Field         | Role                                                      |
| ------------- | --------------------------------------------------------- |
| `ownerUserId` | Stable MCP id used for **all storage** (`saved_packages`, |
|               | `entity_sources`, Vectorize, community listing ownership, |
|               | entitlements)                                             |
| `ownerScope`  | Platform username (package name prefix)                   |
| `ownerEmail`  | Platform account email                                    |
| `actorUserId` | Signed-in caller (always the person)                      |
| `delegated`   | `true` when acting under a grant                          |

Storage paths use **only** `ownerUserId`. The actor is never written into
ownership columns; it appears in audit events instead.

Capabilities that accept `package_scope` include package save/get/list/delete/
update, git-lane publish (`package_get_git_remote`,
`package_publish_external_push`), and community publish/unpublish.

## Security invariant

**Package scope grants exist only on platform accounts.** This is structural,
not policy:

- `insertPackageScopeGrant` in `scope-grants.ts` rejects person accounts as
  scope owners.
- `getPlatformAccountByUsername` returns null unless
  `users.account_type = 'platform'`.
- The resolver never treats another person account as a delegatable scope.

Admins can act **as** a platform account (for example `@kody`); acting **as**
(or reading data of) another person user is deliberately unrepresentable in the
API.

## Audit

Each delegated resolution logs `package_scope_delegated_access` in the audit log
(`category: account`, `result: success`) with the acting person's email and
`reason: scope=@<username>`.

## Admin capabilities

The `admin` MCP domain exposes:

- `admin_platform_account_create` — provision a platform account (reserved
  username, no login).
- `admin_package_scope_grant_create` — grant a person access to a platform
  scope.
- `admin_package_scope_grant_revoke` — remove a grant.
- `admin_package_scope_grant_list` — list grants (optionally filtered by scope
  owner).

## Operator workflow

Typical path for official packages and onboarding starters:

1. Operator creates the `kody` platform account (if missing).
2. Operator receives a package scope grant on `@kody`.
3. From their own MCP session, the operator passes `package_scope: "kody"` to
   the git lane: `package_get_git_remote` → clone/edit/push →
   `package_publish_external_push`.
4. Community listings are published with `community_publish` and the same
   `package_scope`, so featured starters display as `@kody/...`.

## Intentionally not built

Delegation covers package-scope grants only. It does **not** include:

- org/team roles or membership tiers beyond a single grant bit
- invitations or self-service grant requests
- org management UI (grants are admin MCP capabilities today)
- `repo_*` capability delegation — repo sessions remain personal-scope only;
  community forks and installs always land in the caller's personal account

## Future orgs

The actor/owner split and `package_scope_grants` table are the deliberate seed
of a future org/teams feature: scope maps to an owning account, grant maps to
membership. Orgs would extend these tables (roles, management UI), not replace
the mechanism.

## Source of truth in code

- `packages/worker/src/package-registry/scope-grants.ts` — grant CRUD and
  platform account lookup
- `packages/worker/src/package-registry/package-owner.ts` — scope resolution and
  audit
- `packages/worker/migrations/0072-package-scope-grants.sql` — schema
- `packages/worker/src/identity/reserved-usernames.ts` — username denylist
