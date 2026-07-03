# Proposal: role-based access control (RBAC)

**Status: proposal.** Nothing in this document exists in the repository yet.
Present-tense statements about roles, permissions, admin routes, or guard
utilities describe the intended design, not current behavior.

## Why

Kody currently has exactly two authorization states: unauthenticated, and "owner
of this data". Every guard is either a session/OAuth check or a `userId` scope
on a query. There is no way to designate an operator/admin on a shared
deployment, no user management surface, and no vocabulary for granting a
principal more (or less) than full access to their own data.

This proposal adds an Epic Stack-style RBAC layer: users have roles, roles have
permissions, a user's permissions are the union of their roles' permissions, and
permission strings follow the `action:entity:access` format (for example
`read:user:any`). The design deliberately mirrors
[Epic Stack permissions](https://github.com/epicweb-dev/epic-stack/blob/main/docs/decisions/028-permissions-rbac.md)
so the mental model and utility names (`requireUserWithPermission`,
`requireUserWithRole`, `userHasPermission`) transfer directly.

## Relationship to per-user isolation

Per-user isolation stays the default and the hard invariant
([project intent](../project-intent.md), `primitives.yaml`
`per-user-isolation`). RBAC does not weaken it for ordinary users: every
existing data path keeps its `userId` scope, and the implicit access level for
all current behavior is `own`.

What RBAC adds is a **narrow, explicitly-guarded exception** for operators:
permissions with `access = 'any'` allow specific admin endpoints (user listing,
role assignment, account administration) to cross user boundaries. Rules for
that exception:

- `any` access is only honored inside handlers that call
  `requireUserWithPermission(..., '<action>:<entity>:any')`. No general query
  helper ever infers `any` from context.
- Admin permissions cover **account administration** (users, roles), not user
  content. No permission grants cross-user access to secrets, memories,
  packages, jobs, email, or storage. If content-level admin access is ever
  needed, that is a separate proposal.
- `docs/contributing/project-intent.md` and
  `docs/contributing/architecture/primitives.yaml` get updated in the
  implementing PR to describe this exception, so the invariant text and the code
  never disagree.

## Data model

### Migration

One new migration, `packages/worker/migrations/0043-rbac.sql` (next free prefix
at the time of writing — re-check before authoring). Hand-written SQL, following
existing conventions (integer PKs, `TEXT` timestamps, FKs with
`ON DELETE CASCADE`):

```sql
CREATE TABLE IF NOT EXISTS roles (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	name TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS permissions (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	action TEXT NOT NULL,   -- create | read | update | delete
	entity TEXT NOT NULL,   -- user | role | ...
	access TEXT NOT NULL,   -- own | any
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (action, entity, access)
);

CREATE TABLE IF NOT EXISTS role_permissions (
	role_id INTEGER NOT NULL,
	permission_id INTEGER NOT NULL,
	PRIMARY KEY (role_id, permission_id),
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
	FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_roles (
	user_id INTEGER NOT NULL,
	role_id INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, role_id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
```

The same migration seeds the baseline roles and permissions with
`INSERT OR IGNORE`, so every environment (local, e2e, preview, production) gets
them without a separate seed step:

- Role `user` — default role for every account; permissions
  `create|read|update|delete:{entity}:own` for the entities in the registry.
- Role `admin` — operator role; everything `user` has plus
  `create|read|update|delete:user:any` and `create|read|update|delete:role:any`.

Keys are integer `users.id` (the session identifier), **not** the email-hash MCP
`userId`. The users table is the identity anchor; MCP requests resolve roles
through the users row (see the MCP section).

### Deletion cascade

`user_roles` is user-scoped, so the implementing PR must add it to
`userScopedTables` in `packages/worker/src/app/account-deletion.ts` (kind
`db_user_id`, since it keys on integer `users.id`) and to the corresponding
test. FK cascades cover it too, but that list is intentionally explicit.

### Role assignment at signup

The signup path in `packages/worker/src/app/handlers/auth.ts` assigns the `user`
role to every newly created account, in the same transaction/request as the
`users` insert. `tools/seed-test-data.ts` does the same for the fixture account.

### Bootstrap: the first admin

There is no runtime path that grants `admin` (deliberately — no privileged
account at runtime, per project intent). The operator grants it manually, once,
with SQL. Local example:

```bash
node ./wrangler-env.ts d1 execute APP_DB --local --command \
	"INSERT OR IGNORE INTO user_roles (user_id, role_id)
	 SELECT u.id, r.id FROM users u, roles r
	 WHERE u.email = 'you@example.com' AND r.name = 'admin';"
```

For production, run the same statement with `--remote` through the usual
Wrangler env wrapper. After the first admin exists, further role assignment
happens through the admin UI.

## Permission registry (the agent-facing source of truth)

Permission strings are typed, not free-form. A single module —
`packages/worker/src/app/permissions.ts` — defines the vocabulary:

```ts
export const permissionActions = ['create', 'read', 'update', 'delete'] as const
export const permissionEntities = ['user', 'role'] as const
export const permissionAccesses = ['own', 'any'] as const

export type PermissionAction = (typeof permissionActions)[number]
export type PermissionEntity = (typeof permissionEntities)[number]
export type PermissionAccess = (typeof permissionAccesses)[number]

export type PermissionString =
	`${PermissionAction}:${PermissionEntity}:${PermissionAccess}`

export function parsePermissionString(value: PermissionString) {
	const [action, entity, access] = value.split(':')
	return { action, entity, access } as {
		action: PermissionAction
		entity: PermissionEntity
		access: PermissionAccess
	}
}
```

Rules that keep this agent-friendly:

- Every call site passes a literal `PermissionString`, so a typo or an
  undeclared entity is a compile error, not a silent 403.
- Adding a new entity is a two-file change: add it to `permissionEntities` and
  write a migration inserting the new permission rows (and attaching them to
  roles). A unit test asserts the DB seed and the TypeScript registry agree, so
  drift fails `npm run validate` instead of surfacing at runtime.
- Role names get the same treatment:
  `export const roleNames = ['user', 'admin'] as const` plus a `RoleName` type.

## Server utilities

New module `packages/worker/src/app/permissions-server.ts` (name mirrors the
Epic Stack's `permissions.server.ts` split between shared types and server
logic):

```ts
// Loads roles + union of permissions for a user in one D1 query
// (user_roles -> roles -> role_permissions -> permissions).
export async function getUserRolesAndPermissions(
	db: D1Database,
	userId: number,
): Promise<{ roles: Array<RoleName>; permissions: Array<PermissionString> }>

// Pure checks, usable everywhere (server + client payloads).
export function userHasPermission(
	user: { permissions: Array<PermissionString> },
	permission: PermissionString,
): boolean
export function userHasRole(
	user: { roles: Array<RoleName> },
	role: RoleName,
): boolean

// Request guards for handlers. On failure they throw a Response
// (403 JSON for API routes; the HTML-shell variants redirect to /login
// when unauthenticated and return 403 when authenticated but unauthorized).
export async function requireUserWithPermission(
	request: Request,
	env: Env,
	permission: PermissionString,
): Promise<AuthenticatedAppUser>
export async function requireUserWithRole(
	request: Request,
	env: Env,
	role: RoleName,
): Promise<AuthenticatedAppUser>
```

`readAuthenticatedAppUser` in `packages/worker/src/app/authenticated-user.ts`
grows two fields — `roles` and `permissions` — loaded fresh per request (one
extra D1 query; no caching, so revocation takes effect immediately and there is
nothing to invalidate). Roles are **not** stored in the session cookie for the
same reason.

Guard usage in a handler stays one line, matching the existing
`readAuthenticatedAppUser` + 401 pattern:

```ts
const user = await requireUserWithPermission(request, env, 'read:user:any')
```

## Session payload and client-side checks

`GET /session` (`packages/worker/src/app/handlers/session.ts`) adds `roles` and
`permissions` to its payload. The client session store
(`packages/worker/client/session.ts`) exposes them, and the pure
`userHasPermission` / `userHasRole` helpers work on the client payload for
conditional rendering (for example, showing the Admin nav link in
`packages/worker/client/app.tsx` only for admins).

Client checks are cosmetic only; every mutation is re-checked server-side by the
request guards.

## Admin UI

New route group under `/admin`, following the established server-shell + JSON
API + client route pattern (see `/account/secrets` for the reference
implementation):

| Route               | Kind                                     | Guard                                        |
| ------------------- | ---------------------------------------- | -------------------------------------------- |
| `/admin`            | HTML shell (redirects to `/admin/users`) | `requireUserWithRole('admin')`               |
| `/admin/users`      | HTML shell                               | `requireUserWithRole('admin')`               |
| `/admin/users.json` | GET list / POST actions                  | per-action `requireUserWithPermission`       |
| `/admin/roles`      | HTML shell                               | `requireUserWithRole('admin')`               |
| `/admin/roles.json` | GET list                                 | `requireUserWithPermission('read:role:any')` |

Scope for the first iteration:

- **Users page** — paginated user list (id, username, email, created_at, roles).
  Actions: assign role (`create:user:any` … modeled as updating the user, so
  `update:user:any`), remove role (`update:user:any`). Guardrail: an admin
  cannot remove their own `admin` role if they are the last admin (server check,
  clear error message).
- **Roles page** — read-only view of roles and the permissions attached to each.
  Role/permission _definitions_ live in code + migrations (the typed registry is
  the source of truth), so the UI does not edit them in v1. This keeps the UI
  small and keeps agents editing permissions where the type system can check
  them.

Files, mirroring the secrets pattern:

- `packages/worker/src/app/handlers/admin-users.ts` (+ `.node.test.ts`)
- `packages/worker/src/app/handlers/admin-roles.ts` (+ `.node.test.ts`)
- `packages/worker/client/routes/admin-users.tsx`
- `packages/worker/client/routes/admin-roles.tsx`
- Route entries in `packages/worker/src/app/routes.ts`,
  `packages/worker/src/app/router.ts`, and
  `packages/worker/client/routes/index.tsx`.

Unauthorized access: JSON APIs return `403` with `{ ok: false, error }`; HTML
shells return `403` for signed-in non-admins and redirect to
`/login?redirectTo=...` for signed-out visitors. Role assignment and removal
emit audit log events via the existing `logAuditEvent` helper (category
`admin`), matching how account mutations are logged today.

## MCP surface

MCP requests authenticate via OAuth bearer tokens whose grant `props` were
frozen at authorization time (`packages/worker/src/oauth-handlers.ts`). Roles
must **not** ride in grant props — they would go stale on revocation. Instead:

- `packages/worker/src/mcp-auth.ts` loads roles/permissions fresh when building
  `McpCallerContext` (look up the `users` row by the grant's email, then reuse
  `getUserRolesAndPermissions`). The context user shape in
  `packages/shared/src/chat.ts` gains optional `roles` / `permissions` arrays.
- A new helper beside `requireMcpUser`
  (`packages/worker/src/mcp/capabilities/meta/require-permission.ts`):
  `requireMcpUserWithPermission(ctx, permission)`.

No MCP capabilities need guards in v1 — every existing capability is
`own`-scoped by construction and stays that way. The helper exists so future
admin capabilities (if any) have an obvious, consistent guard, and so the
per-user isolation invariant has a single named escape hatch on the MCP side
too. Per the compact-MCP-surface invariant, any future admin functionality lands
as capabilities behind `search`/`execute`, never as new top-level tools.

## Testing

- **Unit (`*.node.test.ts`)** — permission string parsing; registry/seed drift
  check (walk the migration inserts or query a migrated test DB and compare to
  the typed registry); `getUserRolesAndPermissions` union semantics (multi-role
  users, no roles, unknown permissions); guard behavior (401 unauthenticated,
  403 wrong role, passthrough with role); last-admin guardrail; admin handler
  tests following `account-secrets.node.test.ts` patterns.
- **Playwright E2E** — extend `e2e/playwright-utils.ts` with an
  `assignRole(email, role)` fixture (direct D1 insert, same mechanism as
  `insertNewUser`). Spec: non-admin gets 403 on `/admin/users` and sees no Admin
  nav link; admin sees the user list, assigns a role to a second seeded user,
  sees it reflected; the promoted user's `/session` payload includes the new
  role.
- **Seed script** — `tools/seed-test-data.ts` gains an optional `--admin` flag
  granting the fixture user the `admin` role locally.

`npm run validate` remains the single gate; all of the above runs inside it.

## Documentation and agent affordances

Shipped in the implementing PRs, not as a follow-up:

- `docs/contributing/architecture/authorization.md` — present-tense description
  of the shipped system (model, tables, guard utilities, admin routes, the
  `any`-access exception). Linked from the architecture index and
  `authentication.md`.
- `.agents/skills/rbac/SKILL.md` — the Epic-Stack-style skill file: how to add
  an entity/permission, how to guard a route or capability, when to use `own` vs
  `any`, with copy-pasteable examples. This is the primary affordance for future
  agents; the Epic `epic-permissions` skill is the template.
- Updates to `docs/contributing/project-intent.md` (RBAC as the named,
  account-administration-only exception to isolation) and
  `docs/contributing/architecture/primitives.yaml` (new `rbac` primitive in the
  `auth` group; amended `per-user-isolation` invariant text).
- This proposal gets deleted once the design doc above exists (per the docs
  gardening principle).

## Suggested PR sequence

Each step is independently shippable and keeps `npm run validate` green:

1. **Core** — migration `0043-rbac.sql`, typed permission registry,
   `permissions-server.ts` utilities, `readAuthenticatedAppUser` + `/session`
   wiring, signup role assignment, account-deletion table list, seed script
   flag, unit tests.
2. **Admin UI** — `/admin/users` + `/admin/roles` (server handlers, JSON APIs,
   client routes, nav link), audit events, handler tests, Playwright E2E.
3. **MCP context** — roles/permissions on `McpCallerContext`,
   `requireMcpUserWithPermission`, shared schema update, tests.
4. **Docs & skill** — `authorization.md`, `.agents/skills/rbac/SKILL.md`,
   project-intent and primitives.yaml updates, delete this proposal. (Can be
   folded into 1–3 if preferred; listed separately so no code PR blocks on
   prose.)

## Explicitly out of scope

- Role/permission CRUD from the UI (definitions live in code + migrations).
- Cross-user access to user _content_ (secrets, memories, packages, jobs, email,
  storage) under any permission.
- Per-organization tenancy, team workspaces, or permission delegation between
  users — project intent explicitly excludes these.
- Embedding roles in session cookies or OAuth grant props (staleness).
