/**
 * Shared personal-memory owner resolution for metaMemory* capabilities.
 * Surface orgPermission is `none` so team-org connections can invoke; handlers
 * authorize against the personal org and store under that owner id (ADR 0072).
 */
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	authorize,
	loadResourceListScope,
	orgResource,
	type ResourceListScope,
} from '#worker/authorization/authorize.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	personalMemoryOwnerId,
	personalMemoryOwnerRequest,
} from '#mcp/memory/memory-owner.ts'
import { requireMcpRequest, requireMcpUser } from './require-user.ts'

export const memoryPersonalOnlyOrgPermission = 'none' as const

export type PersonalMemoryAuth = {
	userId: OwnerId
	request: RequestContext
	email: string
}

export function requirePersonalMemoryAuth(
	ctx: CapabilityContext,
): PersonalMemoryAuth {
	const user = requireMcpUser(ctx.callerContext)
	const bound = requireMcpRequest(ctx.callerContext)
	const request = personalMemoryOwnerRequest({
		request: bound,
		userId: user.userId,
	})
	return {
		userId: personalMemoryOwnerId(user.userId),
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
