# Authorization

Kody has two permission systems, and neither implies the other:

|            | Org access                                             | Site admin                                               |
| ---------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Who        | Every user, in their org                               | Kody staff                                               |
| Vocabulary | `resource-type:action` (`package:read`, `org:execute`) | `action:entity:access` (`read:user:any`), `admin` role   |
| Checked by | `authorize` (`packages/worker/src/authorization/`)     | `requiredRole` / `requiredPermission`, `require*` guards |
| Source     | `packages/shared/src/org-permissions.ts`               | `packages/worker/universal/permissions.ts`               |

Being a site admin grants no org permission. Holding every org permission (an
org Owner) grants nothing site-wide. Say **site admin** for the second system,
never "operator" or a bare "admin".

## Org access

Every request carries a `RequestContext`
([Request context](./request-context.md)). One function decides whether it may
do something:

```ts
await authorize({ env, request }, 'package:read', {
	type: 'package',
	id: saved.id,
	orgId: request.org.id,
	label: saved.name,
})
```

Without a resource it checks an org-level permission. It throws
`AuthorizationError` (an `McpCallerError`) naming the denial code, the
permission, the org, and the resource. `checkPermission` is the same decision,
synchronous, for callers that already hold the compiled permissions.

`authorize` runs these steps in order:

1. **Signed in.** A request without a person (`request: null`) is denied.
2. **Org binding.** The resource must belong to `request.org.id` (`wrong_org`).
3. **Effective permissions.** `computeEffectivePermissions` compiles
   memberships, team memberships, and grants (`access-compile.ts`): Owner holds
   every permission; Member and Billing hold their org-level basics plus any
   direct or team grants; outside collaborators hold `search:read` plus grants
   (and `org:execute` when they hold `package:execute` somewhere, the ad-hoc
   rule). Compiled results are stored in `access_cache` and keyed by
   `orgs.access_epoch`. Automation (no actor) acts for the org that owns the
   job, webhook, or subscription. The result is also cached per request context.
4. **Credential scopes.** Non-null `credential.scopes` narrow the result.
5. **Connection profile.** A bound profile narrows package resources to the
   packages and actions it lists (`read`, `execute`, `write`). Profiles list
   packages only, so they do not narrow other resources or org-level checks.
   `package:write`, `package:delete`, and `package:publish` handlers call
   `authorizePackageWrite` once the saved package row is known. Those
   permissions map to the profile `write` action, so a profile that lists only
   `read` cannot mutate, delete, or publish that package. A profile-bound
   credential cannot create a saved package: `denyProfileBoundPackageCreate`
   runs from `packageSave` and `packageGetGitRemote` when the package does not
   exist yet, and from `communityFork` and `repoPromoteToPackage`. Plain repo
   create stays an org-level `package:create` check. A profile names existing
   packages only.

A surface check without a resource (capability `orgPermission`, Open API
`x-kody-permission`) passes when the permission is held at org level **or on any
resource grant** in the org. A check with a resource requires that resource.
Personal-org Owners hold every permission, so steps 2 to 4 never deny for them.
Profiles and the signed-in step are the other denials that can fire.

**Ad-hoc credential resolution** (ad hoc `execute`, CLI `--local` gateway
without a package stamp, MCP execute without package secret authority): before
expanding `{{secret:…}}` / `{{integration-token:…}}`, signing with
`secretJwtSign`, using a provider door key, or calling a connected MCP server
from execute, the handler calls `authorize` with `secret:use` or
`integration:use` on that resource (`authorization/credential-use.ts`).
Package-authority runs do **not** require the runner to hold Use on each
credential: the package's binding / allowlist / usageMode / provider grant is
the grant, and the runner needs `package:execute`. Credential storage keys use
`ownerIdFromCaller` (org id), not the acting person. Automation is Owner. See
[ADR 0021](../decisions/0021-publish-gated-package-composition.md).

### Checking many resources

Lists, search, and background checks compile once and decide per resource:

```ts
const access = await computeEffectivePermissions({ env, request })
const visible = packages.filter((pkg) =>
	canSeeResource(access, packageResource(pkg)),
)
```

- `checkPermission(access, permission, resource)` is one decision.
- `canSeeResource` is list and search visibility: the request holds some
  permission on the resource. An execute-only profile still shows the package so
  it can be invoked; reading its source or skills needs `package:read`.
- `runWithRequestPermissions` binds the compiled permissions for deep call sites
  that carry no caller context. Package import resolution reads them with
  `getRequestPermissions` and checks `package:execute` on each imported package.
- `packageResource(pkg)` builds the resource from the stored package row. Its
  org is the package's owning org, so a package from another org denies with
  `wrong_org` unless the request is bound to that org (as a member or through a
  grant).

The connection profile comes from `request.credential.profileName`. Automation
keeps the profile of the credential that created the job or webhook, and a run
started by another run keeps its starter's profile. Read the profile there,
never from the wire `connectionProfileName`.

### Surfaces declare their permission

Every capability definition has a required
`orgPermission: OrgPermission | 'none'`
(`packages/worker/src/mcp/capabilities/types.ts`), so a capability without one
does not compile. `defineCapability` checks it at dispatch with
`authorizeSurface`, after the site-admin and feature-flag gates. Handlers then
call `authorize` with the concrete resource they touch.

Open API operations publish the same declaration as `x-kody-permission` and in
each operation's description. Capability operations take it from the capability;
native operations declare it in `nativeRoute`
(`packages/worker/src/open-api/operations.ts`).

`none` means the surface touches no org data: who-am-I, static guides,
discovery, platform feedback, your own tokens, and site-admin tools, which
`requiredRole` gates instead. `registry.node.test.ts` fails when a site-admin
capability declares an org permission, and `operations.node.test.ts` fails when
an operation publishes no valid permission.

API tokens carry org-permission scopes (`org:execute`, `package:read`, …).
`authorize` step 4 narrows the compiled role by `credential.scopes`. There is no
write-implies-read hierarchy and no separate `x-kody-scope` check.

Connection profiles remain an org-bound narrowing layer (not folded into
scopes). A profile is stored with `org_id` and limits package resources listed
on that credential; it does not replace token scopes.

## Site admin

The rest of this page covers site admin. Kody is multi-user with strict per-user
isolation as the default. Site-admin RBAC adds a **narrow, explicitly-guarded
exception** for Kody staff: permissions with `access = 'any'` allow specific
account-administration endpoints to cross user boundaries. Site-admin-owned
system email for reserved platform addresses is the other deliberate exception:
it is stored under the reserved `system:email` owner id, not any human account.
See [Project intent](../project-intent.md) and the `per-org-isolation` invariant
in [Primitives map](./primitives.yaml).

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

### Model

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

The typed registry in `packages/worker/universal/permissions.ts` is the source
of truth for valid permission strings. Call sites pass literal
`PermissionString` values so typos and undeclared entities are compile errors.

### Baseline roles

The squashed baseline (`packages/worker/migrations/0001-squashed-init.sql`)
defines the RBAC tables and seeds two roles:

- **`user`** — default role assigned at signup. Permissions:
  `create|read|update|delete:{entity}:own` for every entity in the registry.
- **`admin`** — operator role. Everything `user` has, plus
  `create|read|update|delete:{entity}:any` for every entity in the registry.

Role names are typed: `roleNames = ['user', 'admin']` in `permissions.ts`.

There is no runtime path that grants `admin`. The first admin is bootstrapped
with SQL (see [First admin bootstrap](#first-admin-bootstrap) below).

## Database tables

Four D1 tables. The one account-scoped table, `user_roles`, is keyed on integer
`users.id` (the session identifier), not the MCP stable `userId`
(`users.stable_user_id`):

| Table              | Purpose                                       |
| ------------------ | --------------------------------------------- |
| `roles`            | Named roles (`user`, `admin`)                 |
| `permissions`      | `(action, entity, access)` tuples, unique     |
| `role_permissions` | Many-to-many: which permissions each role has |
| `user_roles`       | Many-to-many: which roles each user has       |

`user_roles` is included in the account-deletion cascade list in
`packages/worker/src/app/account-deletion.ts` (`kind: 'db_user_id'`).

## Typed registry and extending it

`packages/worker/universal/permissions.ts` exports:

- `permissionActions`, `permissionEntities`, `permissionAccesses` — const arrays
- `PermissionString` — template literal type
- `parsePermissionString`, `buildPermissionString`
- `listRegistryPermissionStrings()` — Cartesian product of all registry tuples
- `userHasPermission`, `userHasRole` — pure checks usable on server and client

To add a new entity:

1. Add the entity name to `permissionEntities` in
   `packages/worker/universal/permissions.ts`.
2. Write a migration (next free prefix under `packages/worker/migrations/`)
   inserting the new permission rows and attaching them to roles via
   `role_permissions`.
3. The drift test in `packages/worker/src/identity/permissions.node.test.ts`
   compares migration `INSERT` rows to `listRegistryPermissionStrings()` and
   role attachment rules — drift fails `npm run validate`.

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
transiently, the browser lookup fails closed: the user stays authenticated with
empty roles and permissions until the query recovers (`loadUserAndRoles` in
`packages/worker/src/app/request-auth-cache.ts`). MCP context throws on that D1
error, so the request stops. See [MCP context](#mcp-context).

### Where guards are used

| Route / handler                        | Guard                                              |
| -------------------------------------- | -------------------------------------------------- |
| `GET /admin`                           | `requireUserWithRole('admin')` → redirect to users |
| `GET /admin/users`                     | `requireUserWithRole('admin')`                     |
| `GET /admin/users.json`                | `requireUserWithPermission('read:user:any')`       |
| `POST /admin/users.json` (roles, plan) | `requireUserWithPermission('update:user:any')`     |
| `GET /admin/roles`                     | `requireUserWithRole('admin')`                     |
| `GET /admin/roles.json`                | `requireUserWithPermission('read:role:any')`       |
| `GET /admin/system-email`              | `requireUserWithRole('admin')`                     |
| `GET /admin/system-email.json`         | `requireUserWithRole('admin')`                     |
| `POST /admin/system-email.json`        | `requireUserWithRole('admin')`                     |

Handlers: `packages/worker/src/app/handlers/admin-users.ts`,
`packages/worker/src/app/handlers/admin-roles.ts`.

The users list accepts `q` (username/email substring), `role`, and
`verification=stalled` (unverified person accounts whose latest signup/verify
send is still `accepted` after 60 minutes). Stall is derived from the user row;
it is not a stored delivery status.

`POST /admin/users.json` dispatches on an `action` field: `assign_role`,
`remove_role`, `update_plan` (set or clear — `plan: null` — a user's entitlement
plan; see [Entitlements](./entitlements.md)), and `create_user` (pre-verified
account plus a password-setup link). Those mutations emit audit events via
`logAuditEvent` with category `admin`.

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
(`packages/worker/src/app/handlers/auth.ts` via `assignUserRole`). If role
assignment fails, the user row is rolled back so signup can be retried.

Admins can also create a pre-verified account by email from `/admin/users`. That
action is guarded by `requireUserWithPermission('update:user:any')`, uses the
shared `adminCreateUserWithPasswordSetup` service, assigns only the default
`user` role, and returns a password-setup link for the admin to send manually.
It does not grant admin and does not send email automatically.

`tools/seed-test-data.ts` seeds the default fixture account (`kody@example.com`)
with the `admin` role and a companion regular account (`jane@example.com`) with
the `user` role only, so both sides of RBAC are testable out of the box. Custom
`--email` accounts stay non-admin unless `--admin` is passed; `--no-admin` opts
the default account out.

## MCP context

MCP requests authenticate via OAuth bearer tokens. Roles must **not** ride in
grant props. They would go stale on revocation.

`mcp-auth.ts` calls `buildMcpUserContextFromGrantProps`
(`packages/worker/src/mcp-auth-user-context.ts`). The users row is
`grantProps.userId` (`users.stable_user_id`), then roles for that integer id:

```ts
const userId = grantProps.userId.trim()
const row = await env.APP_DB.prepare(
	`SELECT id, email, username, display_name, stable_user_id,
		deleting_at, email_verified_at, suspended_at, password_changed_at
	 FROM users
	 WHERE stable_user_id = ?`,
)
	.bind(userId)
	.first()
if (!row || row.deleting_at) return null
const { roles, permissions } = await getUserRolesAndPermissions(
	env.APP_DB,
	row.id,
)
```

A missing or blank `userId`, or a deleting account, returns null. A D1 error
throws.

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

### Background and package callers

Admin role membership is a property of the account, not of an interactive
session. Package code that runs without a human present acts as the package
owner and carries that owner's current roles and permissions.
`resolveBackgroundMcpUser`
(`packages/worker/src/identity/background-mcp-user.ts`) loads them from D1 with
`getUserRolesAndPermissions` for every `executionOrigin: 'background'` caller it
builds: package jobs, inbound webhook handlers, package subscription handlers,
package exports invoked from other package code, package workflows, and
retrievers. The per-binding identity cache holds a resolved user for up to 60
seconds, so a revoked role can still pass background checks until that entry
expires and the owner is resolved again. Interactive MCP and browser requests
reload roles on every request.

`requiredRole` / `requiredPermission` checks compare against those roles and do
not inspect `executionOrigin`. No admin capability has an interactive-only gate,
so package code owned by an admin can call admin-gated capabilities unattended —
reads and mutations alike — with the same reach as that admin calling them from
an MCP session. That includes fleet-wide / cross-user mutations such as
`adminPackageCodemodApply` (republishes other users' published packages), and
other high-blast writes such as `adminUserCreate`, `adminFeatureFlagSet`, and
`adminSystemEmailSend`. Interactive-only gates exist on a few specific non-admin
capabilities (for example `communityForkAdopt`, `packageAppFetch`,
`packageSubscriptionDispatch`, and platform-feedback submit); they are
per-capability contracts, not part of role evaluation. Interactive-only
`executionOrigin` gates for admin mutations, and separate service principals,
are deferred designs — not applied as a silent gate on these capabilities.

Package app HTTP handlers and realtime hooks call capabilities through the
package-app runtime bridge
(`packages/worker/src/package-runtime/package-app.ts`). The bridge builds its
caller context from worker props (user id, email, display name) without roles,
so those direct capability calls do not see admin capabilities. That holds for
realtime hooks even though the realtime session resolves a role-bearing context
when it builds the app worker; only identity fields reach the bridge. Package
exports that app or realtime code invokes run through the background path above
and do carry the owner's roles.

Treat any package saved on an admin account as running with full admin reach,
including those mutations. See the residual-risk entry in
[Security](../security.md#accepted-residual-risks-and-out-of-scope-items).

## Privacy boundary

The admin role is an **account-administration** role, not a general data-access
role. User-approved platform feedback is a narrow user-content exception.

**For account administration, admins can see only** user id, username, email,
email-verification state (including the latest verification-mail delivery
outcome), entitlement plan, first-touch marketing attribution fields when
present, activation first-seen timestamps (email verified, first MCP connection,
first execute, first saved package, first secret, first integration, first job),
MCP client name when known, last-active stamps, `created_at`, `updated_at`, and
role assignments. The plan is account metadata (it drives quota enforcement),
not user content, and admins can change it via `/admin/users` or the
`adminUserUpdate` MCP capability. Admins can mark an account email verified or
mint a one-time verify URL via `/admin/users` or `adminUserVerify`.

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

A successful resolve or dismiss transition emails the submitter from the
platform transactional sender (`kody@<apex>`), with `Reply-To: support@<apex>`.
The mail uses the standard transactional template: the decision, thanks, and an
invitation to send more feedback through their agent. Optional `user_message` is
included only in that email and is never stored. `admin_note` is never mailed.
The status update succeeds even if the email cannot send. Triage does not email.
Already-resolved or already-dismissed no-op updates do not send, so existing
terminal records are not backfilled. Sends are skipped when the submitter has no
current account email, outbound email is paused, or the account is suspended.
One email is sent per feedback id per terminal status.

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
content. The fresh consumer-time fan-out is the authorization boundary for who
receives the event; handlers do not re-check roles. The handler itself runs as
the admin package owner with that owner's roles (see
[Background and package callers](#background-and-package-callers)). This remains
a narrow exception only for feedback shown to and explicitly approved by the
user; receiving the event grants no role or data access beyond what the owner
already holds. Username and email are stored submission-time snapshots. Package
events never resolve mutable live profile data, and persisted feedback rows
always carry both snapshots.

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
secrets, memories, packages, jobs, user inbox email, durable storage, MCP
servers, or OAuth grants. None of it appears in platform-feedback admin
payloads. Text a user explicitly approves as part of a feedback submission is
visible only through the dedicated feedback exception.

**Admins separately moderate deliberately shared community content.** Public
community listing snapshots can be reviewed for featuring, delisting, and
deletion, and attributed community reports can be reviewed and resolved. Those
community surfaces expose content users chose to publish or report; they do not
grant access to private package source or unrelated account content.

**Admins can inspect activity metadata for public community listings.** The
`adminCommunityActivityList` capability returns a paginated, newest-first feed
of fork and rating rows with listing id/name/package name leaf, acting username,
timestamp, and rating scores. Existing storage does not distinguish a one-click
install from an ordinary fork, so both appear as `fork`. The capability omits
stable user ids, forked package/source ids, origin commits, target package name
leaves, rating notes, private package source, and all unrelated account content.
Fork rows snapshot the public listing name and package name leaf so intentional
listing deletion does not erase retained fork provenance; legacy orphan rows
whose listing identity cannot be recovered use explicit deleted/unknown
placeholders. `adminCommunityOrphanForksCleanup` is a separate audited
maintenance mutation that previews or deletes leftover `community_forks` rows
whose entity source and saved package are both gone. It can name those fork,
package, and source ids because operators need them to confirm the row. Healthy
inert forks (source present, no `saved_packages` row) are not orphans.

New fork and rating writes enqueue an opaque activity id for durable
`community.activity.recorded` package-subscription delivery. The Queue consumer
reloads only the same metadata projection and fans out only to packages whose
owners hold the admin role at processing time. A non-admin may declare the topic
but never receives it, and role revocation applies on the next attempt. Each
write gets a distinct event id for package-invocation idempotency. Deleted
activity is acknowledged as a permanent cancellation; transient lookup,
discovery, and package-invocation infrastructure failures retry and can reach
the dedicated DLQ.

The first community listing publish enqueues an opaque listing id for durable
`community.listing.published` package-subscription delivery. Republishes do not
enqueue this topic. Fan-out, payload redaction, and retry semantics match
[the admin events guide](../../guides/admin-events.md#communitylistingpublished-admins):
admin owners only, metadata-only listing fields (including canonical
`public_url`), permanent cancellation for missing or inactive listings, and
enqueue failures that never fail `communityPublish`.

A republish that moves the pinned commit fans `community.fork.upstream_updated`
out across accounts, and only to accounts that hold a `community_forks` row for
that listing. Each forker receives public listing metadata (id, name, package
name leaf, `public_url`, publisher username, pinned commits and versions) plus
identifiers of their own fork. The event never carries the publisher's stable
id, email, or source, and never names other forkers. Delivery goes only to
packages owned by that forker.

**Admins can subscribe to public status-page incidents.** The isolated status
worker records component incidents in its own Durable Object, then best-effort
POSTs metadata to the main worker. Fan-out of `status.incident.opened` and
`status.incident.resolved` selects only packages whose owners hold the admin
role at dispatch time. A non-admin may declare the topic but never receives it.
The event contains the public status URL, component id, probe detail, and ISO
timestamps. It omits probe logs, health-check bodies, user identities, secrets,
and unrelated account content. Resolved incidents may also carry an optional
operator retrospective on `/` and `/status.json`; that text is public
operational narrative, not user data. Delivery is best-effort (no Queue);
`/status.json` polling remains the backstop.

**Admins can subscribe to fleet package-runtime error-rate elevations.** The
hourly usage-aggregation lane compares anonymous Analytics Engine totals for
`package_export`, `package_static_call`, `job_run`, and `workflow_run`. When the
combined error rate rises, Kody fans `fleet.package_error_rate.elevated` only to
packages whose owners hold the admin role at dispatch time. The event contains
window bounds, per-metric counts and rates, the public status URL, and the
insights URL. When one account or a few accounts own the recent-window errors,
it also names those usernames and package name leaves. It omits user ids,
package UUIDs, emails, error strings, logs, and unrelated account content. This
is operator telemetry about kody itself, not a user-data exception. Delivery is
best-effort (no Queue). A six-hour cooldown suppresses repeat pages. A
concentrated spike still pages the fleet; it does not reroute as a per-user
storm.

**Admins can subscribe to fleet entitlement crossings.** The hourly
`usage_entitlement_alert` lane sweeps the top ~15 active accounts and fans
`fleet.entitlement.crossed` only to packages whose owners hold the admin role at
dispatch time. One event fires per 80% or 100% crossing of a plan-limit
resource, per first over-threshold runtime-duration month, per first
over-threshold unique Dynamic Worker cost month, or per first three-of-seven
execute-cap train. The event contains the stable user id, username, resource
label and counts (or runtime duration, unique-worker days, or days at the
execute cap), and admin insights/users URLs. It omits emails, plans, secrets,
package source, and unrelated account content. Delivery is best-effort (no
Queue). Staying over the same threshold does not emit again.

**Admins can subscribe to person-account create and delete.** Password signup,
social-login signup, and admin-created person accounts fan `user.created`.
Self-service account deletion fans `user.deleted`. Fan-out selects only packages
whose owners hold the admin role at dispatch time. The event contains the stable
user id, username, email, create source or delete timestamp, and first-touch
marketing attribution when present. It omits passwords, roles, plan, secrets,
and unrelated account content. Delivery is best-effort (no Queue) after the
account change commits.

**Admins can subscribe to verification-mail terminal failures.** The first
bounce, failure, rejection, or complaint on a signup/verify send fans
`user.email_verification.failed` only to packages whose owners hold the admin
role at dispatch time. The event contains the stable user id, username, email,
delivery status, `class` (`sender_block` / `other` / `null`), an
`/admin/users/:stableUserId` URL, and `occurred_at`. It omits SMTP transcripts,
tokens, and unrelated account content. Delivery is best-effort (no Queue) after
the user row already carries the bounce.

**Admins can subscribe to stalled verification sends.** The hourly
`email_verification_stall_alert` lane fans `user.email_verification.stalled`
only to packages whose owners hold the admin role at dispatch time when an
unverified person account still has `accepted` after 60 minutes with no
Cloudflare lifecycle event. The event contains the stable user id, username,
email, `accepted_at`, stall threshold, an `/admin/users/:stableUserId` URL, and
`occurred_at`. It omits SMTP transcripts, tokens, and unrelated account content.
Delivery is best-effort (no Queue). Idempotency keys include the accepted
timestamp so a later hourly scan of the same send does not emit again.

**Admins can subscribe to outbound-mail abuse pauses.** After one spam complaint
or five bounced sends in a UTC day, Kody pauses that account's outbound email
and fans `user.email_outbound.paused` only to packages whose owners hold the
admin role at dispatch time. The event contains the stable user id, username,
email, reason, bounce threshold when the reason is `bounced`, an admin user URL,
and `occurred_at`. Delivery is best-effort (no Queue) after the pause write
commits.

**Admins can subscribe to hourly operator bursts.** The `auth_denial_alert` lane
fans `auth.denial.burst` when MCP auth failures in the last 60 minutes cross 50.
The `email_delivery_alert` lane fans `email.delivery.burst` when shared-domain
bounce or complaint outcomes in the last 60 minutes cross 20. Both payloads are
count, threshold, window, insights URL, and `observed_at`. They omit user
identities, tokens, recipients, and message content. A six-hour KV cooldown
suppresses repeat pages. Delivery is best-effort (no Queue).

**Admins can see** operator-owned system mail for reserved platform addresses
(`kody`, `support`, `abuse`, `postmaster`, `security`, `admin`, and `psl`). That
mail is stored under `system:email` as platform content, not under Kent's or any
other user's account. Admin reads through MCP (`adminSystemEmailList`,
`adminSystemEmailGet`) and the `/admin/system-email` UI are audit logged. Admins
can **delete** that operator-owned mail with `adminSystemEmailDelete` (and the
matching delete action on `/admin/system-email`), which removes the message row,
attachments, delivery-event rows, blobs, and an empty parent thread — never
user-owned mailbox content. Admins can also **send** from those reserved
addresses with `adminSystemEmailSend` (also audit logged, with redacted
recipients): that channel speaks for the platform, so it uses no user mailbox,
sender identity, or plan entitlement, and it never reads or writes user-owned
mail. Stored system mail also fans out metadata (never bodies or attachment
bytes) on the `email.system-message.received` package subscription topic, and
only to packages saved by users who hold the admin role at dispatch time — a
non-admin subscriber never receives the event, and revoking admin stops delivery
immediately. Successful reserved-sender sends fan `email.system-message.sent`
the same admin-only way. That outbound topic includes the sent correspondence
(recipients, subject, and bodies) because those sends are not written to the
dedicated inbound graph (the graph refuses provider-message-id rows). It does
not include user-owned mailbox content.

This boundary is enforced structurally:

1. **The permission vocabulary cannot express general user content access.**
   `permissionEntities` contains only `user` and `role`, so a guard like
   `requireUserWithPermission(..., 'secret:read:any')` is a compile error.
2. **Admin account queries touch identity tables only.** `/admin/users*.json`
   and role handlers select explicit column lists from `users`, `user_roles`,
   and `roles`. They never join user content tables. `/admin/system-email*.json`
   is separate and reads only the operator-owned `system_email_*` graph; it
   never falls back to user rows or a Mailbox Durable Object.
3. **Platform feedback has a dedicated role-gated service boundary.** Submit
   writes are scoped to the authenticated user and require
   `user_confirmed: true` from an interactive context at the capability
   boundary. Admin list reads use a summary projection that omits full details;
   get and triage operations address only the selected approved submission. They
   never join unrelated user-content tables.
4. **Community activity has a dedicated role-gated metadata projection.**
   `adminCommunityActivityList` unions only `community_forks` and
   `community_ratings`, uses snapshotted/public listing identity plus acting
   username, and projects an explicit field allowlist. It never selects package
   source, rating notes, email, stable user ids, or unrelated user-content
   tables. Delivery reuses the same projection through fresh admin-owner
   fan-out.
5. **A shape test pins the admin users API payload.**
   `adminUserListItemFieldNames` in `admin-users.ts` defines the allowed fields
   (`stableUserId`, `username`, `email`, `email_verified`, `email_verified_at`,
   plan fields, suspension / outbound-pause stamps, verification-mail delivery
   fields, first-touch UTM and landing fields, activation and last-active
   stamps, `mcp_client_name`, `created_at`, `updated_at`, `roles`). The unit
   test in `admin-users.node.test.ts` asserts every user object in the list
   response has exactly those keys — an accidental widening fails
   `npm run validate`.
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

- `packages/worker/src/authorization/authorize.ts` — org access check
- `packages/shared/src/org-permissions.ts` — org permission vocabulary
- `packages/worker/universal/permissions.ts` — typed registry
- `packages/worker/src/identity/permissions-db.ts` — D1 queries
- `packages/worker/src/app/permissions-server.ts` — request guards
- `packages/worker/migrations/0001-squashed-init.sql` — schema and seed data
- `packages/worker/src/app/handlers/admin-users.ts` — users admin API
- `packages/worker/src/app/handlers/admin-roles.ts` — roles admin API
- `packages/worker/src/mcp-auth-user-context.ts` — MCP role loading
- `packages/worker/src/identity/background-mcp-user.ts` — background package
  caller role loading
- `packages/worker/src/mcp/capabilities/meta/require-permission.ts` — MCP guard
