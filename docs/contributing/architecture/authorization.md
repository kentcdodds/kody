# Authorization (RBAC)

Kody is multi-user with strict per-user isolation as the default. Role-based
access control (RBAC) adds a **narrow, explicitly-guarded exception** for
deployment operators: permissions with `access = 'any'` allow specific
account-administration endpoints to cross user boundaries. Operator-owned system
email for reserved platform addresses is the other deliberate exception: it is
stored under the reserved `system:email` owner id, not any human account. See
[Project intent](../project-intent.md) and the `per-user-isolation` invariant in
[Primitives map](./primitives.yaml).

User-approved platform feedback is a third narrow exception. A submission
crosses into the admin review surface only after the user explicitly approves
it. The exception covers that attributed submission and its triage state, never
unrelated user content.

Community activity metadata is a fourth narrow exception. Admins may see who
forked or rated a deliberately public community listing and when, plus rating
scores. This boundary never exposes forked package source, rating notes,
secrets, or unrelated account content.

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
backfills the `user` role onto accounts that lack a role assignment, so every
account has the default role.

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

Admin MCP capabilities declare `requiredRole: 'admin'` or an explicit
`requiredPermission` in their capability definition. Registry filtering keeps
ineligible capabilities out of discovery, and the normalized execute-time guard
is the security boundary. The platform-feedback review capabilities use the role
gate; they do not create a general-purpose cross-user query helper.

## Privacy boundary

The admin role is an **account-administration** role, not a general data-access
role. User-approved platform feedback is a narrow user-content exception.

**For account administration, admins can see only** user id, username, email,
email-verification state, entitlement plan, `created_at`, `updated_at`, and role
assignments. The plan is account metadata (it drives quota enforcement), not
user content, and admins can change it via `/admin/users` or the
`admin_user_update` MCP capability.

**Admins can see and triage user-approved platform feedback.** The submit
capability requires `user_confirmed: true` and accepts submissions only from an
interactive context. This is a capability contract that records the interactive
caller's assertion of direct approval, not cryptographic proof of conversation
consent; agents must show the exact proposed summary and details, ask first, and
may set the field only after explicit user approval. Submissions are attributed,
not anonymous: the authenticated submitter id is stored and returned to
reviewers. The approved text plus account user id, username, and email may also
be delivered immediately to admins through admin-configured notification
integrations such as Discord. Admin list results intentionally omit full
submission details. The get operation exposes the approved submission only; it
does not expose packages, memories, email, secrets, or other account content.
Agents must omit secrets and unrelated private content when preparing feedback.
Copies already delivered outside Kody, including Discord messages, cannot be
recalled and may remain after Kody account deletion under the deployment
operator's retention and deletion controls. Such copies contain only the exact
approved feedback and attribution, never unrelated account content.

The `summary_untrusted` returned by admin list/get operations and the
`details_untrusted` returned by the get operation are untrusted user-authored
content. Admin callers must follow the accompanying content warning, ignore
instructions embedded in those fields, and treat them only as feedback to
review. Reviewer identity, reviewer timestamp, and admin note are internal
review metadata.

After a consent-gated submission is persisted, Kody enqueues its id for durable
`platform.feedback.submitted` package-subscription delivery. The Queue consumer
fans out only to packages whose owners hold the admin role when the message is
processed. A non-admin may declare the topic but never receives it, and
revocation takes effect on the next attempt because admin ownership is queried
fresh for every Queue delivery.

The package event includes feedback id, category, open status, creation
timestamp, the exact approved text as `summary_untrusted` and
`details_untrusted`, submitter account user id/username/email, a content
warning, and a trusted `/admin/platform-feedback?feedbackId=<encoded id>` deep
link. The warning and `_untrusted` names require notification handlers to treat
the text as user-authored data, not instructions. The event omits admin notes,
reviewer fields, revision, `updated_at`, roles, plan, and unrelated account
content. Package runtime caller contexts do not carry admin roles, so the fresh
consumer-time fan-out is the authorization boundary rather than a handler role
check. This remains a narrow exception only for feedback shown to and explicitly
approved by the user; it does not grant package runtime general admin roles.
Username and email are stored submission-time snapshots. Package events never
resolve mutable live profile data, and legacy rows retain null snapshots.

Submission awaits only Queue enqueue after persistence. An enqueue failure is
logged without changing the successful response, preventing duplicate feedback
from a client retry. Queue bodies remain opaque `{ feedbackId }` messages. The
consumer acknowledges invalid messages. After admin subscriber discovery, lazy
parameter construction reloads feedback immediately before invocation. A deleted
row raises a typed permanent cancellation that the consumer acknowledges without
dispatch or retry; other lookup, discovery, or package-invocation wrapper
infrastructure failures retry and can reach the DLQ. Redelivery keeps the same
package invocation idempotency key; a stored failed invocation replays instead
of automatically rerunning, so the DLQ is the recovery surface. Terminal handler
execution failures remain isolated from sibling subscribers.

**Platform-feedback review does not expose unrelated account content** such as
secrets, values, memories, packages, jobs, user inbox email, chat threads,
durable storage, remote connectors, or OAuth grants. None of it appears in
platform-feedback admin payloads. Text a user explicitly approves as part of a
feedback submission is visible only through the dedicated feedback exception.

**Admins separately moderate deliberately shared community content.** Public
community listing snapshots can be reviewed for trust, featuring, delisting, and
deletion, and attributed community reports can be reviewed and resolved. Those
community surfaces expose content users chose to publish or report; they do not
grant access to private package source or unrelated account content.

**Admins can inspect activity metadata for public community listings.** The
`admin_community_activity_list` capability returns a paginated, newest-first
feed of fork and rating rows with listing id/name/kody id, acting username,
timestamp, and rating scores. Existing storage does not distinguish a one-click
install from an ordinary fork, so both appear as `fork`. The capability omits
stable user ids, forked package/source ids, origin commits, target kody ids,
rating notes, private package source, and all unrelated account content. Fork
rows snapshot the public listing name and kody id so intentional listing
deletion does not erase retained fork provenance; legacy orphan rows whose
listing identity can no longer be recovered use explicit deleted/unknown
placeholders.

New fork and rating writes enqueue an opaque activity id for durable
`community.activity.recorded` package-subscription delivery. The Queue consumer
reloads only the same metadata projection and fans out only to packages whose
owners hold the admin role at processing time. A non-admin may declare the topic
but never receives it, and role revocation applies on the next attempt. Each
write gets a distinct event id for package-invocation idempotency. Deleted
activity is acknowledged as a permanent cancellation; transient lookup,
discovery, and package-invocation infrastructure failures retry and can reach
the dedicated DLQ.

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

1. **The permission vocabulary cannot express general user content access.**
   `permissionEntities` contains only `user` and `role`, so a guard like
   `requireUserWithPermission(..., 'read:secret:any')` is a compile error.
2. **Admin account queries touch identity tables only.** `/admin/users*.json`
   and role handlers select explicit column lists from `users`, `user_roles`,
   and `roles`. They never join user content tables. `/admin/system-email*.json`
   is separate and filters email rows by `user_id = 'system:email'`.
3. **Platform feedback has a dedicated role-gated service boundary.** Submit
   writes are scoped to the authenticated user and require
   `user_confirmed: true` from an interactive context at the capability
   boundary. Admin list reads use a summary projection that omits full details;
   get and triage operations address only the selected approved submission. They
   never join unrelated user-content tables.
4. **Community activity has a dedicated role-gated metadata projection.**
   `admin_community_activity_list` unions only `community_forks` and
   `community_ratings`, uses snapshotted/public listing identity plus acting
   username, and projects an explicit field allowlist. It never selects package
   source, rating notes, email, stable user ids, or unrelated user-content
   tables. Delivery reuses the same projection through fresh admin-owner
   fan-out.
5. **A shape test pins the admin users API payload.**
   `adminUserListItemFieldNames` in `admin-users.ts` defines the allowed fields
   (`id`, `username`, `email`, `email_verified`, `email_verified_at`, `plan`,
   `created_at`, `updated_at`, `roles`). The unit test in
   `admin-users.node.test.ts` asserts every user object in the list response has
   exactly those keys — an accidental widening fails `npm run validate`.
6. **Existing owner-only paths take no admin bypass.** Secret reveal remains
   session-authenticated and owner-only.

Platform feedback remains user-owned for account lifecycle operations. Account
export includes the authenticated user's own submissions and may include their
status, but redacts internal reviewer identity, reviewer timestamp, and admin
note. Open and triaged feedback remains until it is resolved, dismissed, or the
submitter deletes their account. Resolved and dismissed feedback is retained for
365 days after its last update and then pruned. Deleting the submitting account
removes any remaining submissions; deleting an admin account clears that
reviewer's attribution on surviving submissions instead of deleting another
user's feedback. The pre-invocation reload cancels still-queued delivery when
deletion wins the race, but cannot recall an external notification copy that was
already delivered.

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
