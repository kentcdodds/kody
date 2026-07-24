import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type PermissionString,
	type RoleName,
	userHasPermission,
	userHasRole,
} from '#app/permissions.ts'
import {
	type FeatureFlagKey,
	featureFlagKeys,
} from '#worker/feature-flags/registry.ts'
import { getFeatureFlagsForUser } from '#worker/feature-flags/service.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import {
	type McpAuthDenialReason,
	recordMcpAuthDenial,
} from '#mcp/auth-audit.ts'
import { type BuiltCapabilityRegistry } from './build-capability-registry.ts'
import { type Capability, type CapabilitySpec } from './types.ts'

type CapabilityAccessRequirement = Pick<
	Capability | CapabilitySpec,
	'name' | 'requiredRole' | 'requiredPermission' | 'featureFlag'
>

export type CallerFeatureFlags = Readonly<Record<FeatureFlagKey, boolean>>

type McpUserAccessContext = {
	roles?: Array<string>
	permissions?: Array<string>
} | null

function getUserAccessContext(callerContext: McpCallerContext) {
	return callerContext.user ?? null
}

function hasRequiredRole(user: McpUserAccessContext, role: RoleName) {
	return userHasRole({ roles: (user?.roles ?? []) as Array<RoleName> }, role)
}

function hasRequiredPermission(
	user: McpUserAccessContext,
	permission: PermissionString,
) {
	return userHasPermission(
		{ permissions: (user?.permissions ?? []) as Array<PermissionString> },
		permission,
	)
}

function disabledFeatureFlags(): CallerFeatureFlags {
	return Object.fromEntries(
		featureFlagKeys.map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>
}

async function resolveFeatureFlagUserId(
	db: D1Database,
	callerContext: McpCallerContext,
): Promise<number | null> {
	const user = callerContext.user
	const stableUserId = normalizeStableUserId(user?.userId)
	if (!stableUserId) return null
	const row = await db
		.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ id: number }>()
	return row?.id ?? null
}

/**
 * Resolve the caller's evaluated feature-flag map once per request. Used by
 * registry filtering (search/list) so access checks stay synchronous.
 *
 * Fail-closed rules: anonymous callers and authenticated callers whose stable
 * id cannot be resolved to a `users.id` get every flag off, so gated
 * capabilities never appear with a different flag state than the same user's
 * app session would compute.
 */
export async function resolveCallerFeatureFlags(
	env: Env,
	callerContext: McpCallerContext,
): Promise<CallerFeatureFlags> {
	if (!env.APP_DB) return disabledFeatureFlags()
	if (!callerContext.user?.userId) return disabledFeatureFlags()
	try {
		const userId = await resolveFeatureFlagUserId(env.APP_DB, callerContext)
		if (userId === null) return disabledFeatureFlags()
		return await getFeatureFlagsForUser(env.APP_DB, userId)
	} catch {
		// Fail closed: gated capabilities stay hidden when evaluation fails.
		return disabledFeatureFlags()
	}
}

export function callerCanAccessCapability(
	callerContext: McpCallerContext,
	capability: CapabilityAccessRequirement,
	featureFlags?: CallerFeatureFlags | null,
) {
	const requiredRole = capability.requiredRole
	const requiredPermission = capability.requiredPermission
	const requiredFeatureFlag = capability.featureFlag
	if (!requiredRole && !requiredPermission && !requiredFeatureFlag) {
		return true
	}

	// Flag-gated capabilities also require an authenticated caller: flags are
	// evaluated per user, so there is no meaningful anonymous flag state.
	const user = getUserAccessContext(callerContext)
	if (!user) return false
	if (requiredRole && !hasRequiredRole(user, requiredRole)) return false
	if (requiredPermission && !hasRequiredPermission(user, requiredPermission)) {
		return false
	}
	if (requiredFeatureFlag) {
		// Fail closed when the per-request flag map was not resolved.
		if (!featureFlags) return false
		if (featureFlags[requiredFeatureFlag] !== true) return false
	}
	return true
}

export async function assertCallerCanAccessCapability(
	callerContext: McpCallerContext,
	capability: CapabilityAccessRequirement,
	options: {
		featureFlags?: CallerFeatureFlags | null
		env?: Env
	} = {},
) {
	let featureFlags = options.featureFlags
	if (capability.featureFlag && featureFlags == null && options.env) {
		featureFlags = await resolveCallerFeatureFlags(options.env, callerContext)
	}

	if (callerCanAccessCapability(callerContext, capability, featureFlags)) {
		return
	}

	const user = getUserAccessContext(callerContext)
	const denial = describeCapabilityDenial(user, capability)
	// A denial is the one signal we would have that a principal is walking the
	// capability surface, so it is recorded even though it is not an error.
	await recordMcpAuthDenial({
		db: options.env?.APP_DB,
		action: 'mcp_capability_denied',
		reason: denial.reason,
		email: callerContext.user?.email,
		path: capability.name,
	})
	throw new Error(denial.message)
}

function describeCapabilityDenial(
	user: ReturnType<typeof getUserAccessContext>,
	capability: CapabilityAccessRequirement,
): { reason: McpAuthDenialReason; message: string } {
	if (!user) {
		return {
			reason: 'no_user',
			message: `Authenticated MCP user is required to execute capability "${capability.name}".`,
		}
	}
	if (
		capability.requiredRole &&
		!hasRequiredRole(user, capability.requiredRole)
	) {
		return {
			reason: 'role',
			message: `MCP user lacks required role "${capability.requiredRole}" for capability "${capability.name}".`,
		}
	}
	if (
		capability.requiredPermission &&
		!hasRequiredPermission(user, capability.requiredPermission)
	) {
		return {
			reason: 'permission',
			message: `MCP user lacks required permission "${capability.requiredPermission}" for capability "${capability.name}".`,
		}
	}
	if (capability.featureFlag) {
		return {
			reason: 'feature_flag',
			message: `MCP user lacks required feature flag "${capability.featureFlag}" for capability "${capability.name}".`,
		}
	}
	return {
		reason: 'denied',
		message: `MCP user cannot access capability "${capability.name}".`,
	}
}

export function filterCapabilityRegistryForCaller(
	registry: BuiltCapabilityRegistry,
	callerContext: McpCallerContext,
	featureFlags?: CallerFeatureFlags | null,
): BuiltCapabilityRegistry {
	const capabilityList = registry.capabilityList.filter((capability) =>
		callerCanAccessCapability(callerContext, capability, featureFlags),
	)
	if (capabilityList.length === registry.capabilityList.length) {
		return registry
	}

	const allowedNames = new Set(
		capabilityList.map((capability) => capability.name),
	)
	const allowedDomains = new Set(
		capabilityList.map((capability) => capability.domain),
	)
	const capabilityDomains = registry.capabilityDomains.filter((domain) =>
		allowedDomains.has(domain.name),
	)
	const capabilityDomainDescriptionsByName = Object.fromEntries(
		Object.entries(registry.capabilityDomainDescriptionsByName).filter(
			([name]) => allowedDomains.has(name),
		),
	) as BuiltCapabilityRegistry['capabilityDomainDescriptionsByName']
	const capabilityMap = Object.fromEntries(
		Object.entries(registry.capabilityMap).filter(([, capability]) =>
			allowedNames.has(capability.name),
		),
	) as BuiltCapabilityRegistry['capabilityMap']
	const capabilitySpecs = Object.fromEntries(
		Object.entries(registry.capabilitySpecs).filter(([name]) =>
			allowedNames.has(name),
		),
	) as BuiltCapabilityRegistry['capabilitySpecs']
	const capabilityToolDescriptors = Object.fromEntries(
		Object.entries(registry.capabilityToolDescriptors).filter(([name]) =>
			allowedNames.has(name),
		),
	) as BuiltCapabilityRegistry['capabilityToolDescriptors']
	const capabilityHandlers = Object.fromEntries(
		Object.entries(registry.capabilityHandlers).filter(([name]) =>
			allowedNames.has(name),
		),
	) as BuiltCapabilityRegistry['capabilityHandlers']

	return {
		capabilityList,
		capabilityDomains,
		capabilityDomainDescriptionsByName,
		capabilityMap,
		capabilitySpecs,
		capabilityToolDescriptors,
		capabilityHandlers,
	}
}
