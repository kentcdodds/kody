import { AsyncLocalStorage } from 'node:async_hooks'
import {
	orgPermissions,
	type OrgPermission,
	type OrgResourceType,
} from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	connectionProfileAllows,
	type ConnectionProfileAction,
	type ConnectionProfileGrant,
} from '#universal/connection-profiles/grants.ts'
import { resolveConnectionProfileGrants } from '#worker/connection-profiles/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	compileAccessForRequest,
	resourceGrantKey,
	type CompiledAccess,
} from './access-compile.ts'

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
	/** Org-level permissions (role basics + grants on the org resource). */
	permissions: ReadonlySet<OrgPermission>
	/** True when the actor is an Owner (or Automation acting for the org). */
	isOwner: boolean
	/** Per-resource grants keyed by `${type}:${id}`. */
	resourcePermissions: ReadonlyMap<string, ReadonlySet<OrgPermission>>
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

async function loadProfileGrants(
	env: Env,
	request: RequestContext,
): Promise<ReadonlyArray<ConnectionProfileGrant> | null> {
	const { profileName } = request.credential
	if (!profileName) return null
	// Profiles belong to the account that minted the credential. Automation
	// keeps the profile of the credential that created the job or webhook,
	// and that account is the org's own until orgs have members.
	return await resolveConnectionProfileGrants({
		db: env.APP_DB,
		userId: request.actor?.userId ?? request.org.id,
		profileName,
	})
}

function toEffective(
	compiled: CompiledAccess,
	request: RequestContext,
	profileGrants: ReadonlyArray<ConnectionProfileGrant> | null,
): EffectivePermissions {
	return {
		orgId: compiled.orgId,
		permissions: compiled.orgPermissions,
		isOwner: compiled.isOwner,
		resourcePermissions: compiled.resourcePermissions,
		credentialScopes: request.credential.scopes
			? new Set(request.credential.scopes)
			: null,
		profileGrants,
	}
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
		promise = (async () => {
			const compiled = await compileAccessForRequest({
				db: input.env.APP_DB,
				request: input.request,
			})
			const profileGrants = await loadProfileGrants(input.env, input.request)
			return toEffective(compiled, input.request, profileGrants)
		})()
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

function holdsPermission(
	access: EffectivePermissions,
	permission: OrgPermission,
	resource: OrgResource | undefined,
) {
	if (access.isOwner) return true
	if (access.permissions.has(permission)) return true
	if (resource) {
		const granted = access.resourcePermissions.get(
			resourceGrantKey(resource.type, resource.id),
		)
		return granted?.has(permission) ?? false
	}
	// Surface / discovery checks (§6.3): the permission is held somewhere in
	// the org when any resource grant includes it.
	for (const granted of access.resourcePermissions.values()) {
		if (granted.has(permission)) return true
	}
	return false
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

function denialCode(
	access: EffectivePermissions,
	permission: OrgPermission,
	resource: OrgResource | undefined,
): AuthorizationDenialCode | null {
	if (resource && resource.orgId !== access.orgId) return 'wrong_org'
	if (!holdsPermission(access, permission, resource)) {
		return 'missing_permission'
	}
	if (access.credentialScopes && !access.credentialScopes.has(permission)) {
		return 'credential_scope'
	}
	if (resource && !profileAllows(access.profileGrants, permission, resource)) {
		return 'connection_profile'
	}
	return null
}

function denialMessage(
	code: AuthorizationDenialCode,
	permission: OrgPermission,
	resource: OrgResource | undefined,
) {
	const target = resource ? ` on ${describeResource(resource)}` : ''
	switch (code) {
		case 'unauthenticated':
			return `Authenticated MCP user is required for this capability. It needs ${permission}.`
		case 'wrong_org':
			return `${resource ? describeResource(resource) : 'This resource'} belongs to another org.`
		case 'missing_permission':
			return `Missing ${permission}${target}. An org Owner can grant it.`
		case 'credential_scope':
			return `This credential is not scoped for ${permission}${target}. Agents already on MCP: call cliCredentialBootstrap with lifetime short|long (then auth bootstrap), not tokenCreate.`
		case 'connection_profile': {
			const action = profileActionFor(permission) ?? permission
			return `This connection profile cannot ${action}${resource ? ` ${describeResource(resource)}` : ''}.`
		}
		default: {
			const exhaustive: never = code
			throw new Error(`Unhandled denial code: ${String(exhaustive)}`)
		}
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
	const code = denialCode(access, permission, resource)
	if (!code) return { allowed: true }
	return deny({
		code,
		permission,
		access,
		resource,
		message: denialMessage(code, permission, resource),
	})
}

const packageVisibilityPermissions: ReadonlyArray<OrgPermission> = [
	'package:read',
	'package:execute',
	'package:write',
]

/**
 * Whether a list or search result may show `resource`: the request holds at
 * least one permission on it. A profile that only grants `execute` still
 * shows the package, so it can be invoked.
 */
export function canSeeResource(
	access: EffectivePermissions,
	resource: OrgResource,
) {
	return packageVisibilityPermissions.some(
		(permission) => denialCode(access, permission, resource) === null,
	)
}

/**
 * The org resource for a saved package, bound to the org that owns it
 * (`saved_packages.user_id`). A package from another org is denied with
 * `wrong_org`.
 */
export function packageResource(input: {
	id: string
	userId: string
	label?: string
}): OrgResource {
	return {
		type: 'package',
		id: input.id,
		orgId: ownerIdFromStored(input.userId),
		label: input.label,
	}
}

/**
 * The package:write check for a resolved saved package. Profiles narrow this
 * to grants that list `write`. Call it once the package row is known, before
 * the mutation. `package:delete` and `package:publish` are not profile
 * actions; do not route them through here.
 */
export async function authorizePackageWrite(
	ctx: { env: Env; request: RequestContext | null },
	pkg: { id: string; userId: string; label?: string },
): Promise<void> {
	await authorize(ctx, 'package:write', packageResource(pkg))
}

const requestPermissionsStorage = new AsyncLocalStorage<EffectivePermissions>()

/**
 * Bind the request's permissions for deep call sites that do not carry a
 * caller context (package import resolution). No request binds nothing.
 */
export async function runWithRequestPermissions<T>(
	ctx: { env: Env; request: RequestContext | null },
	run: () => Promise<T>,
): Promise<T> {
	if (!ctx.request) return await run()
	const access = await computeEffectivePermissions({
		env: ctx.env,
		request: ctx.request,
	})
	return await requestPermissionsStorage.run(access, run)
}

/** The permissions bound by `runWithRequestPermissions`, if any. */
export function getRequestPermissions(): EffectivePermissions | undefined {
	return requestPermissionsStorage.getStore()
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
			message: denialMessage('unauthenticated', permission, resource),
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

// Re-export so callers that only need the vocabulary keep one import path.
export { orgPermissions }
