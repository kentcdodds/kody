import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
} from '#mcp/secrets/secret-authority.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'

const mocks = vi.hoisted(() => ({
	resolveCallerFeatureFlags: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(),
	listVisibleEnabledMcpServerRefsCached: vi.fn(),
	getMcpUserServerInstructions: vi.fn(async () => null),
	listPopularAgentPackagesForUser: vi.fn(async () => []),
	loadActiveRetiringNoticeIds: vi.fn(async () => []),
}))

vi.mock('#mcp/capabilities/access-control.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#mcp/capabilities/access-control.ts')
	>('#mcp/capabilities/access-control.ts')
	return {
		...actual,
		resolveCallerFeatureFlags: (...args: Array<unknown>) =>
			mocks.resolveCallerFeatureFlags(...(args as [])),
	}
})

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mocks.getCapabilityRegistryForContext(...(args as [])),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listVisibleEnabledMcpServerRefsCached: (...args: Array<unknown>) =>
		mocks.listVisibleEnabledMcpServerRefsCached(...(args as [])),
}))

vi.mock('#mcp/user-server-instructions-repo.ts', () => ({
	getMcpUserServerInstructions: (...args: Array<unknown>) =>
		mocks.getMcpUserServerInstructions(...(args as [])),
}))

vi.mock('#worker/usage/agent-package-conversation-uses.ts', () => ({
	listPopularAgentPackagesForUser: (...args: Array<unknown>) =>
		mocks.listPopularAgentPackagesForUser(...(args as [])),
}))

vi.mock('#mcp/instructions/retiring-primitives.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#mcp/instructions/retiring-primitives.ts')
	>('#mcp/instructions/retiring-primitives.ts')
	return {
		...actual,
		loadActiveRetiringNoticeIds: (...args: Array<unknown>) =>
			mocks.loadActiveRetiringNoticeIds(...(args as [])),
	}
})

const { assembleMcpServerInstructionsForCaller } =
	await import('./assemble-mcp-server-instructions.ts')

function createCapability(
	name: string,
	overrides: Partial<Capability> = {},
): Capability {
	return {
		name,
		domain: 'meta',
		description: 'Capability for instructions tests.',
		keywords: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: 'type ExampleInput = Record<string, never>',
		async handler() {
			return { ok: true }
		},
		...overrides,
	}
}

function createRegistry(
	capabilities: Array<Capability>,
): BuiltCapabilityRegistry {
	const capabilityMap = Object.fromEntries(
		capabilities.map((capability) => [capability.name, capability]),
	)
	const domains = [
		...new Map(
			capabilities.map((capability) => [
				capability.domain,
				{
					name: capability.domain,
					description: `${capability.domain} domain.`,
				},
			]),
		).values(),
	]
	return {
		capabilityList: capabilities,
		capabilityDomains: domains,
		capabilityDomainDescriptionsByName: Object.fromEntries(
			domains.map((domain) => [domain.name, domain.description]),
		),
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
					source: capability.source,
					...(capability.mcpServer ? { mcpServer: capability.mcpServer } : {}),
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

function createExecuteCallerContext() {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: null,
			storageId: null,
		},
	})
}

const openMeta = createCapability('metaListCapabilities')
const lockedNotion = createCapability('mcp:notion:search', {
	domain: 'mcp:notion',
	source: 'mcp-server',
	mcpServer: {
		serverId: 'server-notion',
		serverName: 'notion',
		kodyName: 'notion',
		mcpToolName: 'search',
		toolName: 'search',
	},
})
const unlockedLinear = createCapability('mcp:linear:list', {
	domain: 'mcp:linear',
	source: 'mcp-server',
	mcpServer: {
		serverId: 'server-linear',
		serverName: 'linear',
		kodyName: 'linear',
		mcpToolName: 'list',
		toolName: 'list',
	},
})

test('MCP instructions count only searchable bindings for bare execute vs stamp packageId', async () => {
	mocks.resolveCallerFeatureFlags.mockResolvedValue({
		'compact-mcp-server-instructions': false,
	})
	// Runtime registry still includes the locked server (dispatch path).
	mocks.getCapabilityRegistryForContext.mockResolvedValue(
		createRegistry([openMeta, lockedNotion, unlockedLinear]),
	)
	mocks.listVisibleEnabledMcpServerRefsCached.mockImplementation(
		async (input?: { packageId?: string | null }) => {
			if (input?.packageId === 'pkg-notion-read') {
				return [
					{ serverId: 'server-notion', name: 'notion' },
					{ serverId: 'server-linear', name: 'linear' },
				]
			}
			return [{ serverId: 'server-linear', name: 'linear' }]
		},
	)

	const env = { APP_DB: {} } as unknown as Env
	const callerContext = createExecuteCallerContext()

	const bareInstructions = await assembleMcpServerInstructionsForCaller({
		env,
		callerContext,
	})
	expect(mocks.listVisibleEnabledMcpServerRefsCached).toHaveBeenLastCalledWith(
		expect.objectContaining({ packageId: null }),
	)
	// Runtime had 2 mcp domains; bare execute may only search 1.
	expect(bareInstructions).toMatch(/1 connected MCP binding/)
	expect(bareInstructions).not.toMatch(/2 connected MCP bindings/)
	// Execution registry is unchanged (still queried with full list).
	expect(mocks.getCapabilityRegistryForContext).toHaveBeenCalled()

	const stampedInstructions = await runWithSecretAuthorityScope(
		new Set(['pkg-notion-read']),
		async () =>
			runWithCurrentSecretAuthority('pkg-notion-read', async () =>
				assembleMcpServerInstructionsForCaller({
					env,
					callerContext,
				}),
			),
	)
	expect(mocks.listVisibleEnabledMcpServerRefsCached).toHaveBeenLastCalledWith(
		expect.objectContaining({ packageId: 'pkg-notion-read' }),
	)
	expect(stampedInstructions).toMatch(/2 connected MCP bindings/)
})
