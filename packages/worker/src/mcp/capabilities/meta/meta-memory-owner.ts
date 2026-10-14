/**
 * Shared personal-memory owner resolution for metaMemory* capabilities.
 * Surface orgPermission is `none` so team-org connections can invoke; handlers
 * authorize against the personal org and store under that owner id (ADR 0072).
 */
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	authorize,
	loadResourceListScope,
	orgResource,
	type ResourceListScope,
} from '#worker/authorization/authorize.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	personalMemoryOwnerId,
	personalMemoryOwnerRequest,
} from '#mcp/memory/memory-owner.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { requireMcpRequest, requireMcpUser } from './require-user.ts'

export const memoryPersonalOnlyOrgPermission = 'none' as const

export const memoryRequiresPersonActorMessage =
	'Memory is personal-only and needs a person actor. Team-owned background jobs without an enablement actor cannot read or write personal memory.'

export type PersonalMemoryAuth = {
	userId: OwnerId
	request: RequestContext
	email: string
}

/**
 * Prefer the verified request actor (job enabler / OAuth person) over the MCP
 * user id. Team-owned background jobs use a synthetic MCP user whose id is the
 * team org; their actor is the enabling person.
 */
export function resolvePersonalMemoryPersonId(
	ctx: CapabilityContext,
): PersonId {
	const user = requireMcpUser(ctx.callerContext)
	const bound = requireMcpRequest(ctx.callerContext)
	return (bound.actor?.userId ?? user.userId) as PersonId
}

export function requirePersonalMemoryAuth(
	ctx: CapabilityContext,
): PersonalMemoryAuth {
	const user = requireMcpUser(ctx.callerContext)
	const bound = requireMcpRequest(ctx.callerContext)
	const personId = resolvePersonalMemoryPersonId(ctx)
	const request = personalMemoryOwnerRequest({
		request: bound,
		userId: personId,
	})
	return {
		userId: personalMemoryOwnerId(personId),
		request,
		email: user.email,
	}
}

export async function authorizePersonalMemory(
	ctx: CapabilityContext,
	permission: OrgPermission,
	memoryId?: string,
): Promise<PersonalMemoryAuth> {
	const auth = requirePersonalMemoryAuth(ctx)
	if (!(await isPersonalOrg(ctx.env.APP_DB, auth.userId))) {
		throw new McpCallerError(memoryRequiresPersonActorMessage)
	}
	await authorize(
		{ env: ctx.env, request: auth.request },
		permission,
		memoryId ? orgResource(auth.request, 'memory', memoryId) : undefined,
	)
	return auth
}

export async function personalMemoryReadScope(
	ctx: CapabilityContext,
): Promise<{ auth: PersonalMemoryAuth; scope: ResourceListScope }> {
	const auth = await authorizePersonalMemory(ctx, 'memory:read')
	const scope = await loadResourceListScope(
		{ env: ctx.env, request: auth.request },
		'memory:read',
		'memory',
	)
	return { auth, scope }
}
