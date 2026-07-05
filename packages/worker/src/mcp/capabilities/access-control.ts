import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type PermissionString,
	type RoleName,
	userHasPermission,
	userHasRole,
} from '#app/permissions.ts'
import { type BuiltCapabilityRegistry } from './build-capability-registry.ts'
import { type Capability, type CapabilitySpec } from './types.ts'

type CapabilityAccessRequirement = Pick<
	Capability | CapabilitySpec,
	'name' | 'requiredRole' | 'requiredPermission'
>

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

export function callerCanAccessCapability(
	callerContext: McpCallerContext,
	capability: CapabilityAccessRequirement,
) {
	const requiredRole = capability.requiredRole
	const requiredPermission = capability.requiredPermission
	if (!requiredRole && !requiredPermission) return true

	const user = getUserAccessContext(callerContext)
	if (!user) return false
	if (requiredRole && !hasRequiredRole(user, requiredRole)) return false
	if (requiredPermission && !hasRequiredPermission(user, requiredPermission)) {
		return false
	}
	return true
}

export function assertCallerCanAccessCapability(
	callerContext: McpCallerContext,
	capability: CapabilityAccessRequirement,
) {
	if (callerCanAccessCapability(callerContext, capability)) return

	const user = getUserAccessContext(callerContext)
	if (!user) {
		throw new Error(
			`Authenticated MCP user is required to execute capability "${capability.name}".`,
		)
	}
	if (
		capability.requiredRole &&
		!hasRequiredRole(user, capability.requiredRole)
	) {
		throw new Error(
			`MCP user lacks required role "${capability.requiredRole}" for capability "${capability.name}".`,
		)
	}
	if (
		capability.requiredPermission &&
		!hasRequiredPermission(user, capability.requiredPermission)
	) {
		throw new Error(
			`MCP user lacks required permission "${capability.requiredPermission}" for capability "${capability.name}".`,
		)
	}
	throw new Error(`MCP user cannot access capability "${capability.name}".`)
}

export function filterCapabilityRegistryForCaller(
	registry: BuiltCapabilityRegistry,
	callerContext: McpCallerContext,
): BuiltCapabilityRegistry {
	const capabilityList = registry.capabilityList.filter((capability) =>
		callerCanAccessCapability(callerContext, capability),
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
