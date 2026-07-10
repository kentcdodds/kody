# Authorization (RBAC)

Kody is multi-user with strict per-user isolation as the default. Role-based
access control (RBAC) adds a **narrow, explicitly-guarded exception** for
deployment operators: permissions with `access = 'any'` allow specific
account-administration endpoints to cross user boundaries. Operator-owned system
email for reserved platform addresses is the other deliberate exception: it is
stored under the reserved `system:email` owner id, not any human account. See
[Project intent](../project-intent.md) and the `per-user-isolation` invariant in
[Primitives map](./primitives.yaml).

For browser and MCP authentication mechanics, see
[Authentication](./authentication.md).

## Model

Users have roles. Roles have permissions. A user's effective permissions are the
**union** of all permissions attached to their roles.

Permission strings follow `action:entity:access`:

| Part     | Values                               | Meaning                                 |
| -------- | ------------------------------------ | --------------------------------------- |
| `action` | `create`, `read`, `update`, `delete` | CRUD-style verb                         |
| `entity` | `user`, `role`                       | What the permission applies to          |
| `access` | `own`, `any`                         | Scope: own account only, or any account |

Examples: `read:user:own`, `update:user:any`, `read:role:any`.

- **`own`** — the default mental model for all existing data paths. Ordinary
  users operate only on their own account and content.
- **`any`** — honored only inside handlers that call
  `requireUserWithPermission(..., '<action>:<entity>:any')` or
  `requireMcpUserWithPermission(ctx, '<action>:<entity>:any')`. No general query
  helper infers `any` from context.

The typed registry in `packages/worker/src/app/permissions.ts` is the source of
truth for valid permission strings. Call sites pass literal `PermissionString`
values so typos and undeclared entities are compile errors.

### Baseline roles

Migration `packages/worker/migrations/0043-rbac.sql` seeds two roles with
`INSERT OR IGNORE`:

- **`user`** — default role assigned at signup. Permissions:
  `create|read|update|delete:{entity}:own` for every entity in the registry.
- **`admin`** — operator role. Everything `user` has, plus
  `create|read|update|delete:{entity}:any` for every entity in the registry.

Role names are typed: `roleNames = ['user', 'admin']` in `permissions.ts`.

Migration `packages/worker/migrations/0044-rbac-backfill-user-role.sql`
backfills the `user` role for accounts created before RBAC existed, so every
account has the default role regardless of when it signed up.

There is no runtime path that grants `admin`. The first admin is bootstrapped
with SQL (see [First admin bootstrap](#first-admin-bootstrap) below).

## Database tables

Four D1 tables. The one account-scoped table, `user_roles`, is keyed on integer
`users.id` (the session identifier), not the email-hash MCP `userId`:

| Table              | Purpose                                       |
| ------------------ | --------------------------------------------- |
| `roles`            | Named roles (`user`, `admin`)                 |
| `permissions`      | `(action, entity, access)` tuples, unique     |
| `role_permissions` | Many-to-many: which permissions each role has |
| `user_roles`       | Many-to-many: which roles each user has       |

`user_roles` is included in the account-deletion cascade list in
`packages/worker/src/app/account-deletion.ts` (`kind: 'db_user_id'`).

## Typed registry and extending it

`packages/worker/src/app/permissions.ts` exports:

- `permissionActions`, `permissionEntities`, `permissionAccesses` — const arrays
- `PermissionString` — template literal type
- `parsePermissionString`, `buildPermissionString`
- `listRegistryPermissionStrings()` — Cartesian product of all registry tuples
- `userHasPermission`, `userHasRole` — pure checks usable on server and client

To add a new entity:

1. Add the entity name to `permissionEntities` in `permissions.ts`.
2. Write a migration (next free prefix under `packages/worker/migrations/`)
   inserting the new permission rows and attaching them to roles via
   `role_permissions`.
3. The drift test in `packages/worker/src/app/permissions.node.test.ts` compares
   migration `INSERT` rows to `listRegistryPermissionStrings()` and role
   attachment rules — drift fails `npm run validate`.

## Server guards

`packages/worker/src/app/permissions-server.ts` provides request guards and
re-exports DB helpers from `permissions-db.ts`:

| Function                             | Behavior                                                     |
| ------------------------------------ | ------------------------------------------------------------ |
| `getUserRolesAndPermissions`         | One D1 query: union of roles and permissions for a user      |
| `requireUserWithPermission`          | Authenticated + permission; else 401/403                     |
| `requireUserWithRole`                | Authenticated + role; else 401/403                           |
| `assignUserRole`                     | Insert into `user_roles`; returns whether a row was inserted |
| `removeUserRole`                     | Delete from `user_roles`                                     |
| `removeAdminRolePreservingLastAdmin` | Atomic admin removal that refuses to delete the last admin   |

Guards throw a `Response` on failure:

- Unauthenticated: `401` JSON (when `Accept` prefers JSON) or redirect to
  `/login?redirectTo=...` for HTML shells.
- Authenticated but unauthorized: `403`.

Handlers catch the thrown `Response` and return it:

```ts
import { requireUserWithPermission } from '#app/permissions-server.ts'

async handler({ request }) {
	try {
		const actor = await requireUserWithPermission(request, env, 'read:user:any')
		// ... authorized work
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}
```

Roles and permissions load **fresh per request** in `readAuthenticatedAppUser`
(`packages/worker/src/app/authenticated-user.ts`). They are not stored in the
session cookie, so revocation takes effect immediately. If the roles query fails
transiently, the lookup fails closed: the user stays authenticated with empty
roles and permissions until the query recovers (the MCP context lookup behaves
the same way).

### Where guards are used

| Route / handler                        | Guard                                              |
| -------------------------------------- | -------------------------------------------------- |
| `GET /admin`                           | `requireUserWithRole('admin')` → redirect to users |
| `GET /admin/users`                     | `requireUserWithRole('admin')`                     |
| `GET /admin/users.json`                | `requireUserWithPermission('read:user:any')`       |
| `POST /admin/users.json` (roles, plan) | `requireUserWithPermission('update:user:any')`     |
| `GET /admin/roles`                     | `requireUserWithRole('admin')`                     |
| `GET /admin/roles.json`                | `requireUserWithPermission('read:role:any')`       |
| `GET /admin/invites`                   | `requireUserWithRole('admin')`                     |
| `GET/POST /admin/invites.json`         | `requireUserWithRole('admin')`                     |
| `GET /admin/system-email`              | `requireUserWithRole('admin')`                     |
| `GET /admin/system-email.json`         | `requireUserWithRole('admin')`                     |

Handlers: `packages/worker/src/app/handlers/admin-users.ts`,
`packages/worker/src/app/handlers/admin-roles.ts`,
`packages/worker/src/app/handlers/admin-invites.ts`.

`POST /admin/users.json` dispatches on an `action` field: `assign_role`,
`remove_role`, and `update_plan` (set or clear — `plan: null` — a user's
entitlement plan; see [Entitlements](./entitlements.md)). All three mutations
emit audit events via `logAuditEvent` with category `admin`.

### Last-admin guardrail

Removing the `admin` role from a user is blocked when that user is the last
remaining admin. The check runs inside the `DELETE` statement itself
(`removeAdminRolePreservingLastAdmin`), so concurrent removals cannot race a
stale count and leave zero admins. The API returns `409` with a clear error
message and logs a failure audit event with reason `last_admin`. When the helper
reports nothing was removed, the handler distinguishes "target is the last
admin" (409) from "target did not have the role" (idempotent no-op) — see
`handleRemoveRoleAction` in `admin-users.ts`.

Signup and admin-created user setup fail with `500` if the seeded `user` role
cannot be assigned (for example after a partial migration), rather than creating
an account with no roles. The just-created `users` row is rolled back so the
account creation can be retried once the environment is fixed.

## Session payload and client helpers

`POST /session` (`packages/worker/src/app/handlers/session.ts`) includes `roles`
and `permissions` in the session payload when the cookie is valid.

The client session store (`packages/worker/client/session.ts`) parses and
exposes them as `SessionInfo`. Pure helpers `userHasPermission` and
`userHasRole` from `permissions.ts` work on the client payload for conditional
rendering — for example, the Admin nav link in `packages/worker/client/app.tsx`
is shown only when `userHasRole(session, 'admin')`.

Client checks are cosmetic only; every mutation is re-checked server-side.

## Signup and seeding

Every new account receives the `user` role in the signup transaction
(`packages/worker/src/app/handlers/auth.ts` via `assignUserRole`) after any
required production invite has been atomically consumed. If role assignment
fails, the user row is rolled back and the invite use is released so signup can
be retried.

Admins can also create a pre-verified account by email from `/admin/invites`.
That action is guarded by `requireUserWithRole('admin')`, uses the shared
`adminCreateUserWithPasswordSetup` service, assigns only the default `user`
role, and returns a password-setup link for the admin to send manually. It does
not grant admin and does not send email automatically.

`tools/seed-test-data.ts` seeds the default fixture account (`kody@example.com`)
with the `admin` role and a companion regular account (`jane@example.com`) with
the `user` role only, so both sides of RBAC are testable out of the box. Custom
`--email` accounts stay non-admin unless `--admin` is passed; `--no-admin` opts
the default account out.

## MCP context

MCP requests authenticate via OAuth bearer tokens. Roles must **not** ride in
grant props — they would go stale on revocation.

Instead, `packages/worker/src/mcp-auth.ts` calls
`buildMcpUserContextFromGrantProps`
(`packages/worker/src/mcp-auth-user-context.ts`) when building
`McpCallerContext`: look up the `users` row by the grant's email, then call
`getUserRolesAndPermissions`. The shared schema in `packages/shared/src/chat.ts`
(`mcpUserContextSchema`) includes optional `roles` and `permissions` arrays on
the user object.

For capability guards, use `requireMcpUserWithPermission` in
`packages/worker/src/mcp/capabilities/meta/require-permission.ts`:

```ts
const user = requireMcpUserWithPermission(ctx, 'read:user:any')
```

No existing MCP capabilities use this helper yet — every current capability is
`own`-scoped by construction. The helper exists for future admin capabilities
behind `search`/`execute`.

## Privacy boundary

The admin role is an **account-administration** role, not a data-access role.

**Admins can see** account metadata only: user id, username, email,
email-verification state, entitlement plan, `created_at`, `updated_at`, and role
assignments. The plan is account metadata (it drives quota enforcement), not
user content, and admins can change it via `/admin/users` or the
`admin_user_update` MCP capability.

**Admins cannot see** user content (secrets, values, memories, packages, jobs,
user inbox email, chat threads, durable storage, remote connectors, OAuth
grants, and so on). None of it appears in admin endpoints, pages, or payloads.

**Admins can see** operator-owned system mail for reserved platform addresses
(`kody`, `support`, `abuse`, `postmaster`, `security`, and `admin`). That mail
is stored under `system:email` as platform content, not under Kent's or any
other user's account. Admin reads through MCP (`admin_system_email_list`,
`admin_system_email_get`) and the `/admin/system-email` UI are audit logged.
Stored system mail also fans out metadata (never bodies or attachment bytes) on
the `email.system-message.received` package subscription topic, and only to
packages saved by users who hold the admin role at dispatch time — a non-admin
subscriber never receives the event, and revoking admin stops delivery
immediately.

This boundary is enforced structurally:

1. **The permission vocabulary cannot express user content access.**
   `permissionEntities` contains only `user` and `role`, so a guard like
   `requireUserWithPermission(..., 'read:secret:any')` is a compile error.
2. **Admin account queries touch identity tables only.** `/admin/users*.json`
   and role handlers select explicit column lists from `users`, `user_roles`,
   and `roles`. They never join user content tables. `/admin/system-email*.json`
   is separate and filters email rows by `user_id = 'system:email'`.
3. **A shape test pins the admin users API payload.**
   `adminUserListItemFieldNames` in `admin-users.ts` defines the allowed fields
   (`id`, `username`, `email`, `email_verified`, `email_verified_at`, `plan`,
   `created_at`, `updated_at`, `roles`). The unit test in
   `admin-users.node.test.ts` asserts every user object in the list response has
   exactly those keys — an accidental widening fails `npm run validate`.
4. **Existing owner-only paths take no admin bypass.** Secret reveal remains
   session-authenticated and owner-only.

The public `/privacy` page and `docs/use/privacy.md` describe this boundary for
end users. RBAC governs the application surface only; deployment operators with
infrastructure access (D1, `SECRET_STORE_KEY`) sit outside application-level
control.

## First admin bootstrap

There is no application UI or API to grant the first `admin` role. Run SQL once
through the Wrangler env wrapper:

```bash
node ./wrangler-env.ts d1 execute APP_DB --local --command \
  "INSERT OR IGNORE INTO user_roles (user_id, role_id)
   SELECT u.id, r.id FROM users u, roles r
   WHERE u.email = 'you@example.com' AND r.name = 'admin';"
```

For production, use `--remote`. After the first admin exists, further role
assignment happens through the admin UI.

## What to read when changing authorization

- `packages/worker/src/app/permissions.ts` — typed registry
- `packages/worker/src/app/permissions-db.ts` — D1 queries
- `packages/worker/src/app/permissions-server.ts` — request guards
- `packages/worker/migrations/0043-rbac.sql` — schema and seed data
- `packages/worker/migrations/0044-rbac-backfill-user-role.sql` — role backfill
  for pre-RBAC accounts
- `packages/worker/src/app/handlers/admin-users.ts` — users admin API
- `packages/worker/src/app/handlers/admin-roles.ts` — roles admin API
- `packages/worker/src/mcp-auth-user-context.ts` — MCP role loading
- `packages/worker/src/mcp/capabilities/meta/require-permission.ts` — MCP guard
