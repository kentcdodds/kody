import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	assertCallerCanAccessCapability,
	callerCanAccessCapability,
	filterCapabilityRegistryForCaller,
	type CallerFeatureFlags,
} from './access-control.ts'
import { type BuiltCapabilityRegistry } from './build-capability-registry.ts'
import { type Capability } from './types.ts'

function createFlagMap(enabled: boolean): CallerFeatureFlags {
	return {
		'demo-indicator': enabled,
		'execute-pre-exec-typecheck': enabled,
	}
}

function createFlaggedCapability(name = 'example_flagged'): Capability {
	return {
		name,
		domain: 'meta',
		description: 'Flagged capability for access-control tests.',
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		featureFlag: 'demo-indicator',
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: 'type ExampleFlaggedInput = Record<string, never>',
		async handler() {
			return { ok: true }
		},
	}
}

function createOpenCapability(name = 'example_open'): Capability {
	return {
		name,
		domain: 'meta',
		description: 'Ungated capability for access-control tests.',
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: 'type ExampleOpenInput = Record<string, never>',
		async handler() {
			return { ok: true }
		},
	}
}

function createRegistry(
	capabilities: Array<Capability>,
): BuiltCapabilityRegistry {
	const capabilityMap = Object.fromEntries(
		capabilities.map((capability) => [capability.name, capability]),
	)
	return {
		capabilityList: capabilities,
		capabilityDomains: [
			{
				name: 'meta',
				description: 'Meta domain for access-control tests.',
			},
		],
		capabilityDomainDescriptionsByName: {
			meta: 'Meta domain for access-control tests.',
		},
		capabilityMap: capabilityMap as BuiltCapabilityRegistry['capabilityMap'],
		capabilitySpecs: Object.fromEntries(
			capabilities.map((capability) => [
				capability.name,
				{
					name: capability.name,
					domain: capability.domain,
					description: capability.description,
					keywords: capability.keywords,
					readOnly: capability.readOnly,
					idempotent: capability.idempotent,
					destructive: capability.destructive,
					...(capability.featureFlag
						? { featureFlag: capability.featureFlag }
						: {}),
					source: capability.source,
					inputFields: [],
					requiredInputFields: [],
					outputFields: [],
					inputSchema: capability.inputSchema,
					inputTypeDefinition: capability.inputTypeDefinition,
				},
			]),
		) as BuiltCapabilityRegistry['capabilitySpecs'],
		capabilityToolDescriptors: {},
		capabilityHandlers: Object.fromEntries(
			capabilities.map((capability) => [capability.name, capability.handler]),
		) as BuiltCapabilityRegistry['capabilityHandlers'],
	}
}

test('featureFlag-gated capabilities are denied and hidden when the flag is off', async () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
			roles: ['user'],
		},
	})
	const flagged = createFlaggedCapability()
	const open = createOpenCapability()
	const disabledFlags = createFlagMap(false)

	expect(callerCanAccessCapability(callerContext, flagged, disabledFlags)).toBe(
		false,
	)
	expect(callerCanAccessCapability(callerContext, open, disabledFlags)).toBe(
		true,
	)

	await expect(
		assertCallerCanAccessCapability(callerContext, flagged, {
			featureFlags: disabledFlags,
		}),
	).rejects.toThrow(/lacks required feature flag "demo-indicator"/)

	const filtered = filterCapabilityRegistryForCaller(
		createRegistry([flagged, open]),
		callerContext,
		disabledFlags,
	)
	expect(filtered.capabilityMap.example_flagged).toBeUndefined()
	expect(filtered.capabilityMap.example_open).toBeTruthy()
})

test('featureFlag-gated capabilities are allowed when the flag is on', async () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
			roles: ['user'],
		},
	})
	const flagged = createFlaggedCapability()
	const enabledFlags = createFlagMap(true)

	expect(callerCanAccessCapability(callerContext, flagged, enabledFlags)).toBe(
		true,
	)
	await expect(
		assertCallerCanAccessCapability(callerContext, flagged, {
			featureFlags: enabledFlags,
		}),
	).resolves.toBeUndefined()

	const filtered = filterCapabilityRegistryForCaller(
		createRegistry([flagged]),
		callerContext,
		enabledFlags,
	)
	expect(filtered.capabilityMap.example_flagged).toBeTruthy()
})

test('featureFlag-gated capabilities fail closed when the flag map is missing', () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
			roles: ['user'],
		},
	})
	const flagged = createFlaggedCapability()
	expect(callerCanAccessCapability(callerContext, flagged)).toBe(false)
	expect(callerCanAccessCapability(callerContext, flagged, null)).toBe(false)
})

test('featureFlag-gated capabilities require an authenticated caller', async () => {
	const anonymousContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
	})
	const flagged = createFlaggedCapability()
	const enabledFlags = createFlagMap(true)

	expect(
		callerCanAccessCapability(anonymousContext, flagged, enabledFlags),
	).toBe(false)
	await expect(
		assertCallerCanAccessCapability(anonymousContext, flagged, {
			featureFlags: enabledFlags,
		}),
	).rejects.toThrow(/Authenticated MCP user is required/)

	const filtered = filterCapabilityRegistryForCaller(
		createRegistry([flagged, createOpenCapability()]),
		anonymousContext,
		enabledFlags,
	)
	expect(filtered.capabilityMap.example_flagged).toBeUndefined()
	expect(filtered.capabilityMap.example_open).toBeTruthy()
})
