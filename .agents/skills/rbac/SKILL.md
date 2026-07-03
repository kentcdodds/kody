---
name: rbac
description:
  Guard app routes and MCP capabilities with Kody's typed RBAC layer. Use when
  adding permissions, protecting admin endpoints, checking own vs any access,
  extending the permission registry, or reviewing the admin privacy boundary.
---

# RBAC (role-based access control)

Kody uses Epic Stack-style RBAC: users have roles, roles have permissions,
effective permissions are the union across roles, and permission strings follow
`action:entity:access`.

Read
[`docs/contributing/architecture/authorization.md`](../../../docs/contributing/architecture/authorization.md)
for the full shipped model. This skill is the copy-paste cheat sheet.

## When to use `own` vs `any`

| Access | Use for                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `own`  | Default. Every existing data path — secrets, packages, jobs, memories, email, storage. Scoped by `userId` at the data layer.                                           |
| `any`  | **Account administration only** — listing users, reading roles, assigning/removing roles. Only inside handlers that explicitly call a guard with an `:any` permission. |

Rules:

- Never add `:any` permissions for content entities. The registry currently has
  only `user` and `role`.
- No query helper infers `any` from context. The guard at the handler entry is
  the only escape hatch from per-user isolation.

## Guard an app route

Import from `packages/worker/src/app/permissions-server.ts`.

**HTML shell** — require a role:

```ts
import { requireUserWithRole } from '#app/permissions-server.ts'

export function createAdminUsersHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithRole(request, env, 'admin')
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
			// ... render shell
		},
	}
}
```

**JSON API** — require a specific permission per action:

```ts
import { requireUserWithPermission } from '#app/permissions-server.ts'

export function createAdminUsersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithPermission(request, env, 'read:user:any')
					// ... return list
				}
				if (request.method === 'POST') {
					const actor = await requireUserWithPermission(
						request,
						env,
						'update:user:any',
					)
					// ... mutate; log audit event (category 'admin')
				}
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	}
}
```

Guards throw `Response` (401 unauthenticated, 403 forbidden). Always catch
`instanceof Response` and return it.

**Client-only check** (cosmetic — never a security boundary):

```ts
import { userHasRole } from '#app/permissions.ts'

const showAdminLink =
	isLoggedIn && session != null && userHasRole(session, 'admin')
```

## Guard an MCP capability

Import from `packages/worker/src/mcp/capabilities/meta/require-permission.ts`.

```ts
import { requireMcpUserWithPermission } from './require-permission.ts'

export async function myAdminCapability(ctx: McpCallerContext) {
	const user = requireMcpUserWithPermission(ctx, 'read:user:any')
	// user.roles and user.permissions are fresh per request
}
```

Roles load in `buildMcpUserContextFromGrantProps` — they do **not** live in
OAuth grant props. No existing capabilities use this yet; add it when shipping
admin functionality behind `search`/`execute`.

## Add a new permission entity (end-to-end)

Example: adding entity `invitation` (hypothetical — do not add without a product
need).

1. **Registry** — add to `permissionEntities` in
   `packages/worker/src/app/permissions.ts`:

   ```ts
   export const permissionEntities = ['user', 'role', 'invitation'] as const
   ```

2. **Migration** — next free prefix under `packages/worker/migrations/`:

   ```sql
   INSERT OR IGNORE INTO permissions (action, entity, access) VALUES ('create', 'invitation', 'own');
   -- ... all action × access combinations for the new entity

   INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
   SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'user' AND p.entity = 'invitation' AND p.access = 'own';

   INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
   SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'admin' AND p.entity = 'invitation';
   ```

3. **Role attachment** — decide which roles get `own` vs `any` for the entity.
   Match the pattern in `0043-rbac.sql`.

4. **Drift test** — `packages/worker/src/app/permissions.node.test.ts` parses
   migration `INSERT` rows and compares to `listRegistryPermissionStrings()`.
   Run `npm run validate`; drift fails the test.

5. **Guards** — use literal `PermissionString` at every new handler/capability
   entry point.

## Privacy boundary rules

Admin endpoints are **metadata-only**. When touching admin code:

- Query only `users`, `user_roles`, `roles`, `permissions`, `role_permissions`.
  Never join content tables.
- Return only fields listed in `adminUserListItemFieldNames` for user list items
  (`id`, `username`, `email`, `created_at`, `updated_at`, `roles`).
- If you add a field to the admin users payload, update
  `adminUserListItemFieldNames` **and** the shape test in
  `admin-users.node.test.ts` deliberately — do not bypass the test.
- Do not add content entities to `permissionEntities` without an explicit
  product decision and doc update to `authorization.md` and
  `docs/use/privacy.md`.

## Last-admin guardrail

Before removing `admin` from a user, check:

```ts
import { countUsersWithRole, removeUserRole } from '#app/permissions-server.ts'

if (roleName === 'admin') {
	const adminCount = await countUsersWithRole(env.APP_DB, 'admin')
	// if target is the last admin, return 409 — see admin-users.ts
}
```

Copy the full pattern from `handleRemoveRoleAction` in
`packages/worker/src/app/handlers/admin-users.ts`.

## Quick reference

| Module                  | Purpose                                |
| ----------------------- | -------------------------------------- |
| `permissions.ts`        | Typed registry, pure `userHas*` checks |
| `permissions-db.ts`     | D1 load/assign/remove                  |
| `permissions-server.ts` | Request guards                         |
| `require-permission.ts` | MCP guard                              |
| `0043-rbac.sql`         | Schema + seed                          |
