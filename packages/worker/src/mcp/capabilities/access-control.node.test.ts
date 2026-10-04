import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	featureFlagKeys,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import type * as FeatureFlagExposure from '#worker/feature-flags/exposure.ts'
import type * as FeatureFlagService from '#worker/feature-flags/service.ts'
import { type FeatureFlagEvaluation } from '#worker/feature-flags/service.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	assertCallerCanAccessCapability,
	callerCanAccessCapability,
	filterCapabilityRegistryForCaller,
	filterCapabilityRegistryMcpServersForCaller,
	resolveCallerFeatureFlags,
	type CallerFeatureFlags,
} from './access-control.ts'
import { type BuiltCapabilityRegistry } from './build-capability-registry.ts'
import { type Capability } from './types.ts'

const flagMocks = vi.hoisted(() => ({
	getFeatureFlagEvaluationsForUser:
		vi.fn<typeof FeatureFlagService.getFeatureFlagEvaluationsForUser>(),
	recordFeatureFlagExposures: vi.fn<
		typeof FeatureFlagExposure.recordFeatureFlagExposures
	>(async () => undefined),
}))

vi.mock('#worker/feature-flags/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof FeatureFlagService>()
	return {
		...actual,
		getFeatureFlagEvaluationsForUser: (
			...args: Parameters<typeof actual.getFeatureFlagEvaluationsForUser>
		) => flagMocks.getFeatureFlagEvaluationsForUser(...args),
	}
})

vi.mock('#worker/feature-flags/exposure.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof FeatureFlagExposure>()
	return {
		...actual,
		recordFeatureFlagExposures: (
			...args: Parameters<typeof actual.recordFeatureFlagExposures>
		) => flagMocks.recordFeatureFlagExposures(...args),
	}
})

function createFlagMap(enabled: boolean): CallerFeatureFlags {
	return {
		'demo-indicator': enabled,
		'package-share-grants': false,
		'jev-search-rerank': false,
		'execute-invoke': false,
		'connection-profiles': false,
	}
}

function createCapability(
	name: string,
	featureFlag?: Capability['featureFlag'],
): Capability {
	return {
		name,
		domain: 'meta',
		description: 'Capability for access-control tests.',
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		...(featureFlag ? { featureFlag } : {}),
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: 'type ExampleInput = Record<string, never>',
		async handler() {
			return { ok: true }
		},
	}
}

const flagged = createCapability('example_flagged', 'demo-indicator')
const open = createCapability('example_open')
const callerContext = createMcpCallerContext({
	baseUrl: 'https://example.com',
	user: {
		userId: 'user-1',
		email: 'user@example.com',
		displayName: 'user',
		roles: ['user'],
	},
})

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
	expect(callerCanAccessCapability(callerContext, flagged)).toBe(false)
	expect(callerCanAccessCapability(callerContext, flagged, null)).toBe(false)
})

test('featureFlag-gated capabilities require an authenticated caller', async () => {
	const anonymousContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
	})
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
		createRegistry([flagged, open]),
		anonymousContext,
		enabledFlags,
	)
	expect(filtered.capabilityMap.example_flagged).toBeUndefined()
	expect(filtered.capabilityMap.example_open).toBeTruthy()
})

test('discovery filter hides package-locked MCP server capabilities by server id', () => {
	const locked: Capability = {
		...createCapability('mcp:notion:search'),
		domain: 'mcp:notion',
		source: 'mcp-server',
		mcpServer: {
			serverId: 'server-notion',
			serverName: 'notion',
			kodyName: 'notion',
			mcpToolName: 'search',
			toolName: 'search',
		},
	}
	const anyContext: Capability = {
		...createCapability('mcp:linear:list'),
		domain: 'mcp:linear',
		source: 'mcp-server',
		mcpServer: {
			serverId: 'server-linear',
			serverName: 'linear',
			kodyName: 'linear',
			mcpToolName: 'list',
			toolName: 'list',
		},
	}
	const registry = createRegistry([locked, anyContext, open])
	const filtered = filterCapabilityRegistryMcpServersForCaller(
		registry,
		new Set(['server-linear']),
	)
	expect(filtered.capabilityMap['mcp:notion:search']).toBeUndefined()
	expect(filtered.capabilityMap['mcp:linear:list']).toBeTruthy()
	expect(filtered.capabilityMap.example_open).toBeTruthy()
})

function createEvaluations(
	enabledByKey: Partial<Record<FeatureFlagKey, boolean>> = {},
): Record<FeatureFlagKey, FeatureFlagEvaluation> {
	return Object.fromEntries(
		featureFlagKeys.map((key) => [
			key,
			{
				enabled: enabledByKey[key] === true,
				source: 'default' as const,
			},
		]),
	) as Record<FeatureFlagKey, FeatureFlagEvaluation>
}

function createFlagResolveEnv(numericUserId: number) {
	return {
		APP_DB: {
			prepare() {
				return {
					bind() {
						return {
							async first() {
								return { id: numericUserId }
							},
						}
					},
				}
			},
		},
	} as unknown as Env
}

test('one MCP request records flag exposures once and reuses the request evaluation', async () => {
	const stableUserId = testStableUserIdFromEmail('flags@example.com')
	const requestContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: stableUserId,
			email: 'flags@example.com',
			displayName: 'flags',
			roles: ['user'],
		},
	})
	const evaluations = createEvaluations({ 'execute-invoke': true })
	flagMocks.getFeatureFlagEvaluationsForUser.mockReset()
	flagMocks.recordFeatureFlagExposures.mockClear()
	flagMocks.getFeatureFlagEvaluationsForUser.mockResolvedValue(evaluations)

	const env = createFlagResolveEnv(42)

	// Same request call sites as a tools/call: registerExecuteTool, live
	// kill-switch re-read, and registry filtering (serial + overlapping).
	const [registered, live, filtered] = await Promise.all([
		resolveCallerFeatureFlags(env, requestContext),
		resolveCallerFeatureFlags(env, requestContext),
		resolveCallerFeatureFlags(env, requestContext),
	])
	const fourth = await resolveCallerFeatureFlags(env, requestContext)

	expect(registered['execute-invoke']).toBe(true)
	expect(live).toBe(registered)
	expect(filtered).toBe(registered)
	expect(fourth).toBe(registered)
	expect(flagMocks.getFeatureFlagEvaluationsForUser).toHaveBeenCalledTimes(1)
	expect(flagMocks.getFeatureFlagEvaluationsForUser).toHaveBeenCalledWith(
		env.APP_DB,
		42,
	)
	expect(flagMocks.recordFeatureFlagExposures).toHaveBeenCalledTimes(1)
	expect(flagMocks.recordFeatureFlagExposures).toHaveBeenCalledWith(env, {
		stableUserId,
		evaluations,
	})

	// A distinct caller context (next HTTP request) must evaluate and record
	// again — no cross-request cache.
	const nextRequestContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: stableUserId,
			email: 'flags@example.com',
			displayName: 'flags',
			roles: ['user'],
		},
	})
	await resolveCallerFeatureFlags(env, nextRequestContext)
	expect(flagMocks.getFeatureFlagEvaluationsForUser).toHaveBeenCalledTimes(2)
	expect(flagMocks.recordFeatureFlagExposures).toHaveBeenCalledTimes(2)
})
