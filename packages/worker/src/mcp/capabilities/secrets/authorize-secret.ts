import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	authorize,
	authorizeOrgWide,
	loadResourceListScope,
	orgResource,
} from '#worker/authorization/authorize.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { findSecret } from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { type StorageContext } from '#mcp/storage.ts'

type SecretPermission = Extract<OrgPermission, `secret:${string}`>

/** Secrets are `secret` resources keyed by name, the key `resolveCredential` checks. */
export async function authorizeSecret(
	ctx: CapabilityContext,
	permission: SecretPermission,
	name: string,
) {
	const request = requireMcpRequest(ctx.callerContext)
	await authorize(
		{ env: ctx.env, request },
		permission,
		orgResource(request, 'secret', name),
	)
}

/** Updating a secret needs Write on it; creating one needs org-level Create. */
export async function authorizeSecretSet(
	ctx: CapabilityContext,
	input: {
		name: string
		scope: SecretScope
		storageContext: StorageContext | null
	},
) {
	const existing = await findSecret({
		env: ctx.env,
		userId: ownerIdFromCaller(ctx.callerContext),
		name: input.name,
		scope: input.scope,
		storageContext: input.storageContext,
	})
	if (existing.found) {
		await authorizeSecret(ctx, 'secret:write', input.name)
		return
	}
	await authorize(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		'secret:create',
	)
}

export async function loadSecretListScope(
	ctx: CapabilityContext,
	permission: SecretPermission,
) {
	return await loadResourceListScope(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
		'secret',
	)
}

/** Vault provider bindings are org-wide configuration, not one secret. */
export async function authorizeSecretOrgWide(
	ctx: CapabilityContext,
	permission: SecretPermission,
) {
	await authorizeOrgWide(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
	)
}
