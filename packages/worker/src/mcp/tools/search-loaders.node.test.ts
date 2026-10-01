import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
} from '#mcp/secrets/secret-authority.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'

const mockModule = vi.hoisted(() => ({
	listSavedPackagesWithCommunityProvenanceByUserId: vi.fn(),
	getSavedPackageWithCommunityProvenanceById: vi.fn(),
	listAcceptedInboundSharedPackages: vi.fn(),
	listPlatformPackagesForSearch: vi.fn(async () => []),
	listVisibleEnabledMcpServerRefsCached: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...(args as [])),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listVisibleEnabledMcpServerRefsCached: (...args: Array<unknown>) =>
		mockModule.listVisibleEnabledMcpServerRefsCached(...(args as [])),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: async () => [],
}))

vi.mock('#worker/integrations/service.ts', () => ({
	listJoinedIntegrations: async () => [],
}))

vi.mock('#worker/package-registry/platform-packages.ts', () => ({
	listPlatformPackagesForSearch: (...args: Array<unknown>) =>
		mockModule.listPlatformPackagesForSearch(...(args as [])),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesWithCommunityProvenanceByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesWithCommunityProvenanceByUserId(...args),
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageWithCommunityProvenanceById(...args),
}))

vi.mock('#worker/package-registry/share-grants.ts', () => ({
	listAcceptedInboundSharedPackages: (...args: Array<unknown>) =>
		mockModule.listAcceptedInboundSharedPackages(...args),
}))

const { loadSearchRowsAndRegistry } = await import('./search-loaders.ts')

function packageRecord(input: { id: string; userId: string; name: string }) {
	return {
		id: input.id,
		userId: input.userId,
		name: input.name,
		kodyId: input.name.split('/').pop() ?? input.name,
		description: '',
		tags: [],
		searchText: null,
		hasApp: false,
		isPrivate: false,
		hidden: false,
		sourceId: `source-${input.id}`,
	}
}

function createCapability(
	name: string,
	overrides: Partial<Capability> = {},
): Capability {
	return {
		name,
		domain: 'meta',
		description: 'Capability for search-loader tests.',
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

test('search rows load inbound shared packages without waiting on the caller package list', async () => {
	mockModule.getCapabilityRegistryForContext.mockResolvedValue(
		createRegistry([]),
	)
	mockModule.listVisibleEnabledMcpServerRefsCached.mockResolvedValue([])
	let releaseOwnList!: () => void
	const ownListGate = new Promise<void>((resolve) => {
		releaseOwnList = resolve
	})
	const own = packageRecord({
		id: 'pkg-own',
		userId: 'user-1',
		name: '@me/own',
	})
	const shared = packageRecord({
		id: 'pkg-shared',
		userId: 'user-2',
		name: '@friend/shared',
	})
	mockModule.listSavedPackagesWithCommunityProvenanceByUserId.mockImplementation(
		async () => {
			await ownListGate
			return [own]
		},
	)
	mockModule.listAcceptedInboundSharedPackages.mockResolvedValue([
		{ id: 'pkg-shared', userId: 'user-2' },
		{ id: 'pkg-own', userId: 'user-1' },
	])
	mockModule.getSavedPackageWithCommunityProvenanceById.mockImplementation(
		async (_db: unknown, { packageId }: { packageId: string }) =>
			packageId === 'pkg-shared' ? shared : own,
	)

	const loading = loadSearchRowsAndRegistry({
		env: { APP_DB: {} } as unknown as Env,
		callerContext: { baseUrl: 'https://example.com' } as never,
		userId: 'user-1',
	})
	await vi.waitFor(() => {
		expect(
			mockModule.getSavedPackageWithCommunityProvenanceById,
		).toHaveBeenCalledTimes(2)
	})
	releaseOwnList()
	const rows = await loading

	expect(
		rows.packageRows.map((row) => ({
			id: row.record.id,
			shareGranted: row.shareGranted === true,
		})),
	).toEqual([
		{ id: 'pkg-own', shareGranted: false },
		{ id: 'pkg-shared', shareGranted: true },
	])
})

test('search discovery hides locked MCP servers for bare execute and shows them under stamp packageId', async () => {
	mockModule.listSavedPackagesWithCommunityProvenanceByUserId.mockResolvedValue(
		[],
	)
	mockModule.listAcceptedInboundSharedPackages.mockResolvedValue([])
	mockModule.getCapabilityRegistryForContext.mockResolvedValue(
		createRegistry([lockedNotion, unlockedLinear]),
	)
	mockModule.listVisibleEnabledMcpServerRefsCached.mockImplementation(
		async (input?: { packageId?: string | null }) => {
			if (input?.packageId === 'pkg-notion-read') {
				return [
					{ serverId: 'server-notion', name: 'notion' },
					{ serverId: 'server-linear', name: 'linear' },
				]
			}
			// Bare execute (null packageId): locked notion is hidden.
			return [{ serverId: 'server-linear', name: 'linear' }]
		},
	)

	const env = { APP_DB: {} } as unknown as Env
	const callerContext = createExecuteCallerContext()

	const bare = await loadSearchRowsAndRegistry({
		env,
		callerContext,
		userId: 'user-1',
	})
	expect(
		mockModule.listVisibleEnabledMcpServerRefsCached,
	).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			packageId: null,
		}),
	)
	expect(bare.registry.capabilityMap['mcp:notion:search']).toBeUndefined()
	expect(bare.registry.capabilityMap['mcp:linear:list']).toBeTruthy()

	const granted = new Set(['pkg-notion-read'])
	const stamped = await runWithSecretAuthorityScope(granted, async () =>
		runWithCurrentSecretAuthority('pkg-notion-read', async () =>
			loadSearchRowsAndRegistry({
				env,
				callerContext,
				userId: 'user-1',
			}),
		),
	)
	expect(
		mockModule.listVisibleEnabledMcpServerRefsCached,
	).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			packageId: 'pkg-notion-read',
		}),
	)
	expect(stamped.registry.capabilityMap['mcp:notion:search']).toBeTruthy()
	expect(stamped.registry.capabilityMap['mcp:linear:list']).toBeTruthy()
})
