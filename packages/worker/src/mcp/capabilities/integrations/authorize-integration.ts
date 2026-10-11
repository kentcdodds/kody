import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	authorize,
	authorizeOrgWide,
	loadResourceListScope,
	orgResource,
} from '#worker/authorization/authorize.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

type IntegrationPermission = Extract<OrgPermission, `integration:${string}`>

/**
 * Integrations and MCP servers are both `integration` resources keyed by
 * their stored name, the same key `resolveCredential` checks.
 */
export async function authorizeIntegration(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
	name: string,
) {
	const request = requireMcpRequest(ctx.callerContext)
	await authorize(
		{ env: ctx.env, request },
		permission,
		orgResource(request, 'integration', name),
	)
}

export async function loadIntegrationListScope(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
) {
	return await loadResourceListScope(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
		'integration',
	)
}

/** OAuth app registrations are org-wide configuration, not one connection. */
export async function authorizeIntegrationOrgWide(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
) {
	await authorizeOrgWide(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
	)
}
