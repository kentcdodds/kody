import {
	orgPermissions,
	type OrgPermission,
	type OrgResourceType,
} from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import {
	connectionProfileAllows,
	type ConnectionProfileAction,
	type ConnectionProfileGrant,
} from '#universal/connection-profiles/grants.ts'
import { resolveConnectionProfileGrants } from '#worker/connection-profiles/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

/** A concrete org resource a permission is checked on. */
export type OrgResource = {
	type: OrgResourceType
	id: string
	orgId: OwnerId
	/** Human-readable name for denial messages (package name, inbox address). */
	label?: string
}

/**
 * What one request may do in its org: the compiled role and grant
 * permissions, then what its credential narrows that to.
 */
export type EffectivePermissions = {
	orgId: OwnerId
	permissions: ReadonlySet<OrgPermission>
	credentialScopes: ReadonlySet<OrgPermission> | null
	/** Null when no connection profile is bound to the credential. */
	profileGrants: ReadonlyArray<ConnectionProfileGrant> | null
}

export type AuthorizationDenialCode =
	| 'unauthenticated'
	| 'wrong_org'
	| 'missing_permission'
	| 'credential_scope'
	| 'connection_profile'

/**
 * A request lacks a permission. Callers can clear it (sign in, use another
 * credential, ask for a grant), so it is an `McpCallerError`.
 */
export class AuthorizationError extends McpCallerError {
	readonly code: AuthorizationDenialCode
	readonly permission: OrgPermission
	readonly orgId: OwnerId | null
	readonly resource: OrgResource | null

	constructor(input: {
		code: AuthorizationDenialCode
		permission: OrgPermission
		orgId: OwnerId | null
		resource: OrgResource | null
		message: string
	}) {
		super(input.message)
		this.name = 'AuthorizationError'
		this.code = input.code
		this.permission = input.permission
		this.orgId = input.orgId
		this.resource = input.resource
	}
}

export type AuthorizationDecision =
	| { allowed: true }
	| { allowed: false; error: AuthorizationError }

const allOrgPermissions: ReadonlySet<OrgPermission> = new Set(orgPermissions)

const rolePresets: Record<OrgRole, ReadonlySet<OrgPermission>> = {
	owner: allOrgPermissions,
	member: new Set(['org:read', 'member:read', 'team:read', 'search:read']),
	billing: new Set([
		'org:read',
		'member:read',
		'search:read',
		'billing:read',
		'billing:write',
	]),
}

function compileOrgPermissions(
	request: RequestContext,
): ReadonlySet<OrgPermission> {
	// Automation acts for the org that owns the job, webhook, or subscription.
	if (!request.actor) return allOrgPermissions
	if (!request.membership) return new Set()
	return rolePresets[request.membership.role]
}

async function loadProfileGrants(
	env: Env,
	request: RequestContext,
): Promise<ReadonlyArray<ConnectionProfileGrant> | null> {
	const { profileName } = request.credential
	if (!profileName) return null
	// A bound profile with no person behind it grants nothing.
	if (!request.actor) return []
	return await resolveConnectionProfileGrants({
		db: env.APP_DB,
		userId: request.actor.userId,
		profileName,
	})
}

const effectivePermissionsByRequest = new WeakMap<
	RequestContext,
	Promise<EffectivePermissions>
>()

/**
 * Compile what `request` may do in its org. Cached per request context, so a
 * request that checks many permissions loads its grants once.
 */
export function computeEffectivePermissions(input: {
	env: Env
	request: RequestContext
}): Promise<EffectivePermissions> {
	let promise = effectivePermissionsByRequest.get(input.request)
	if (!promise) {
		promise = (async () => ({
			orgId: input.request.org.id,
			permissions: compileOrgPermissions(input.request),
			credentialScopes: input.request.credential.scopes
				? new Set(input.request.credential.scopes)
				: null,
			profileGrants: await loadProfileGrants(input.env, input.request),
		}))()
		effectivePermissionsByRequest.set(input.request, promise)
		promise.catch(() => effectivePermissionsByRequest.delete(input.request))
	}
	return promise
}

function profileActionFor(
	permission: OrgPermission,
): ConnectionProfileAction | null {
	switch (permission) {
		case 'package:read':
			return 'read'
		case 'package:execute':
			return 'execute'
		case 'package:write':
			return 'write'
		default:
			return null
	}
}

/**
 * Connection profiles list package grants only, so they narrow package
 * resources and leave every other check to the role and credential.
 */
function profileAllows(
	grants: ReadonlyArray<ConnectionProfileGrant> | null,
	permission: OrgPermission,
	resource: OrgResource,
) {
	if (grants === null || resource.type !== 'package') return true
	const action = profileActionFor(permission)
	if (!action) return false
	return connectionProfileAllows({
		grants,
		resourceType: resource.type,
		resourceId: resource.id,
		action,
	})
}

function describeResource(resource: OrgResource) {
	return `${resource.type} ${resource.label ?? `"${resource.id}"`}`
}

function deny(input: {
	code: AuthorizationDenialCode
	permission: OrgPermission
	access: EffectivePermissions
	resource: OrgResource | undefined
	message: string
}): AuthorizationDecision {
	return {
		allowed: false,
		error: new AuthorizationError({
			code: input.code,
			permission: input.permission,
			orgId: input.access.orgId,
			resource: input.resource ?? null,
			message: input.message,
		}),
	}
}

/**
 * The pure decision behind `authorize`, for callers that already hold the
 * compiled permissions and check many resources at once.
 */
export function checkPermission(
	access: EffectivePermissions,
	permission: OrgPermission,
	resource?: OrgResource,
): AuthorizationDecision {
	const target = resource ? ` on ${describeResource(resource)}` : ''
	if (resource && resource.orgId !== access.orgId) {
		return deny({
			code: 'wrong_org',
			permission,
			access,
			resource,
			message: `${describeResource(resource)} belongs to another org.`,
		})
	}
	if (!access.permissions.has(permission)) {
		return deny({
			code: 'missing_permission',
			permission,
			access,
			resource,
			message: `Missing ${permission}${target}. An org Owner can grant it.`,
		})
	}
	if (access.credentialScopes && !access.credentialScopes.has(permission)) {
		return deny({
			code: 'credential_scope',
			permission,
			access,
			resource,
			message: `This credential is not scoped for ${permission}${target}.`,
		})
	}
	if (resource && !profileAllows(access.profileGrants, permission, resource)) {
		const action = profileActionFor(permission) ?? permission
		return deny({
			code: 'connection_profile',
			permission,
			access,
			resource,
			message: `This connection profile cannot ${action} ${describeResource(resource)}.`,
		})
	}
	return { allowed: true }
}

/**
 * The one org access check (docs/contributing/architecture/authorization.md).
 * Without `resource` it checks an org-level permission. Throws
 * `AuthorizationError` on denial. Site-admin checks are separate.
 */
export async function authorize(
	ctx: { env: Env; request: RequestContext | null },
	permission: OrgPermission,
	resource?: OrgResource,
): Promise<void> {
	if (!ctx.request) {
		throw new AuthorizationError({
			code: 'unauthenticated',
			permission,
			orgId: null,
			resource: resource ?? null,
			message: `Authenticated MCP user is required for this capability. It needs ${permission}.`,
		})
	}
	const access = await computeEffectivePermissions({
		env: ctx.env,
		request: ctx.request,
	})
	const decision = checkPermission(access, permission, resource)
	if (!decision.allowed) throw decision.error
}

/**
 * What a capability or Open API operation requires. `none` declares that it
 * touches no org data (who-am-I, static guides, site-admin tools, which
 * `requiredRole` gates instead).
 */
export type SurfacePermission = OrgPermission | 'none'

/**
 * The dispatch gate every capability and Open API operation passes. The
 * permission must be held in the org; handlers then call `authorize` with
 * the concrete resource.
 */
export async function authorizeSurface(
	ctx: { env: Env; request: RequestContext | null },
	permission: SurfacePermission,
): Promise<void> {
	if (permission === 'none') return
	await authorize(ctx, permission)
}
