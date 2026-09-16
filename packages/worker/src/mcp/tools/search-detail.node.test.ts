import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getValue: vi.fn(),
	getJoinedIntegration: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	collectIntegrationPackageSuggestions: vi.fn(),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#worker/package-registry/platform-packages.ts', () => ({
	listPlatformPackagesForSearch: async () => [],
	findPlatformPackageByRef: async () => null,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageWithCommunityProvenanceByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
}))

vi.mock('#worker/integrations/service.ts', async () => {
	const actual = await vi.importActual<typeof IntegrationsService>(
		'#worker/integrations/service.ts',
	)
	return {
		...actual,
		getJoinedIntegration: (...args: Array<unknown>) =>
			mockModule.getJoinedIntegration(...args),
	}
})

vi.mock('./integration-package-suggestions.ts', () => ({
	collectIntegrationPackageSuggestions: (...args: Array<unknown>) =>
		mockModule.collectIntegrationPackageSuggestions(...args),
}))

const { resolveEntityDetail } = await import('./search-detail.ts')

function createAgent() {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	})
	return {
		getEnv: () => ({ APP_DB: {} }) as Env,
		getCallerContext: () => callerContext,
	} as unknown as McpRegistrationAgent
}

function emptySearchRows() {
	return {
		userValueRows: [],
		userSecretRows: [],
		userIntegrationRows: [],
		packageRows: [],
		registry: { capabilitySpecs: {} },
		warnings: [],
	}
}

function createJoinedIntegration(name: string): JoinedIntegration {
	const now = '2026-01-01T00:00:00.000Z'
	return {
		lane: 'user',
		app: {
			userId: 'user-1',
			slug: name,
			provider: name,
			label: null,
			clientId: `${name}-client-id-value`,
			hasClientSecret: true,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: now,
			updatedAt: now,
		},
		connection: {
			userId: 'user-1',
			name,
			appSlug: name,
			platformAppSlug: null,
			accountLabel: null,
			description: `${name} OAuth integration`,
			scopes: ['repo'],
			requiredHosts: ['api.github.com'],
			usageMode: 'any',
			allowedPackageIds: [],
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: now,
			updatedAt: now,
		},
	}
}

test('resolveEntityDetail reports unresolvable entity refs as caller errors', async () => {
	mockModule.getValue.mockReset()
	mockModule.getValue.mockResolvedValue(null)
	mockModule.getJoinedIntegration.mockReset()
	mockModule.getJoinedIntegration.mockResolvedValue(null)

	const agent = createAgent()
	const callerContext = agent.getCallerContext()
	const searchRows = emptySearchRows() as never
	const resolve = (entity: string) =>
		resolveEntityDetail({
			agent,
			callerContext,
			userId: 'user-1',
			username: 'user',
			entity,
			searchRows,
		})

	const expected = [
		['capability:nope', 'Capability not found.'],
		[
			'user:missing-value:value',
			'Entity type must be one of: capability, guide, integration, mcp-server, package, or secret.',
		],
		['integration:notion', 'Saved integration not found for this user.'],
		['secret:API_KEY', 'Secret not found for this user.'],
		[
			'not-a-ref',
			'Entity must use the format "{type}:{id}" where type is capability, guide, integration, mcp-server, package, or secret.',
		],
		[
			'thing:widget',
			'Entity type must be one of: capability, guide, integration, mcp-server, package, or secret.',
		],
		[
			'home-controls:package',
			'Entity refs are "{type}:{id}". Use "package:home-controls", not "home-controls:package".',
		],
		[
			'emailSend:capability',
			'Entity refs are "{type}:{id}". Use "capability:emailSend", not "emailSend:capability".',
		],
	] as const

	for (const [entity, message] of expected) {
		const detail = resolve(entity)
		await expect(detail).rejects.toThrow(McpCallerError)
		await expect(detail).rejects.toThrow(message)
	}
})

test('resolveEntityDetail lists MCP server tools from the synthesized registry', async () => {
	const agent = createAgent()
	const detail = await resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: 'user-1',
		username: 'user',
		entity: 'mcp-server:home',
		searchRows: {
			...emptySearchRows(),
			registry: {
				capabilityDomains: [
					{
						name: 'mcp:home',
						description: 'Use set_pin after unlocking the island router.',
					},
				],
				capabilitySpecs: {
					'mcp:home:set_pin': {
						name: 'mcp:home:set_pin',
						description: 'Set the island router PIN.',
						domain: 'mcp:home',
						keywords: ['pin'],
						inputFields: ['pin'],
						requiredInputFields: ['pin'],
						outputFields: [],
						readOnly: false,
						idempotent: true,
						destructive: false,
						source: 'mcp-server',
						mcpServer: {
							serverId: 'server-home',
							serverName: 'home',
							kodyName: 'home',
							mcpToolName: 'set_pin',
							toolName: 'set_pin',
						},
						inputSchema: { type: 'object', properties: {} },
						inputTypeDefinition: 'type SetPinInput = { pin: string }',
					},
				},
			},
		} as never,
	})

	expect(detail).toMatchObject({
		type: 'mcp-server',
		id: 'home',
		instructions: 'Use set_pin after unlocking the island router.',
		tools: [
			expect.objectContaining({
				name: 'mcp:home:set_pin',
				entityRef: 'capability:mcp:home:set_pin',
				toolName: 'set_pin',
			}),
		],
	})

	await expect(
		resolveEntityDetail({
			agent,
			callerContext: agent.getCallerContext(),
			userId: 'user-1',
			username: 'user',
			entity: 'mcp-server:missing',
			searchRows: emptySearchRows() as never,
		}),
	).rejects.toThrow('MCP server not found.')
})

test('resolveEntityDetail loads official guides without a signed-in user', async () => {
	const agent = createAgent()
	const detail = await resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: null,
		username: null,
		entity: 'guide:package_authoring',
		searchRows: emptySearchRows() as never,
	})

	expect(detail).toMatchObject({
		type: 'guide',
		id: 'package_authoring',
		slug: 'package-authoring',
		category: 'platform',
	})
	if (detail.type !== 'guide') {
		throw new Error('expected guide entity detail')
	}
	expect(detail.body.startsWith('#')).toBe(true)
	expect(detail.title.length).toBeGreaterThan(0)

	const sectionDetail = await resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: null,
		username: null,
		entity: 'guide:package_subscriptions#repo.pushed',
		searchRows: emptySearchRows() as never,
	})
	expect(sectionDetail).toMatchObject({
		type: 'guide',
		id: 'package_subscriptions',
		section: 'repo.pushed',
	})

	await expect(
		resolveEntityDetail({
			agent,
			callerContext: agent.getCallerContext(),
			userId: null,
			username: null,
			entity: 'capability:search_docs#repo.pushed',
			searchRows: emptySearchRows() as never,
		}),
	).rejects.toThrow(
		/Section fragments are only supported on guide and package entities/,
	)

	await expect(
		resolveEntityDetail({
			agent,
			callerContext: agent.getCallerContext(),
			userId: null,
			username: null,
			entity: 'guide:not_a_real_guide',
			searchRows: emptySearchRows() as never,
		}),
	).rejects.toThrow('Guide not found.')

	await expect(
		resolveEntityDetail({
			agent,
			callerContext: agent.getCallerContext(),
			userId: null,
			username: null,
			entity: 'guide:admin_events',
			searchRows: emptySearchRows() as never,
		}),
	).rejects.toThrow('Guide not found.')

	const adminCaller = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'admin-1',
			email: 'admin@example.com',
			displayName: 'admin',
			roles: ['admin'],
		},
	})
	const adminAgent = {
		getEnv: () => ({ APP_DB: {} }) as Env,
		getCallerContext: () => adminCaller,
	} as unknown as McpRegistrationAgent
	const adminGuide = await resolveEntityDetail({
		agent: adminAgent,
		callerContext: adminCaller,
		userId: 'admin-1',
		username: 'admin',
		entity: 'guide:admin_events',
		searchRows: emptySearchRows() as never,
	})
	expect(adminGuide).toMatchObject({
		type: 'guide',
		id: 'admin_events',
		slug: 'admin-events',
	})
})

test('resolveEntityDetail loads {name}:integration via getJoinedIntegration', async () => {
	const joined = createJoinedIntegration('github')
	mockModule.getJoinedIntegration.mockReset()
	mockModule.getJoinedIntegration.mockResolvedValue(joined)
	mockModule.collectIntegrationPackageSuggestions.mockReset()
	mockModule.collectIntegrationPackageSuggestions.mockResolvedValue([])

	const agent = createAgent()
	const detail = await resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: 'user-1',
		username: 'user',
		entity: 'integration:github',
		searchRows: emptySearchRows() as never,
	})

	expect(mockModule.getJoinedIntegration).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		userId: 'user-1',
		name: 'github',
	})
	expect(detail).toMatchObject({
		type: 'integration',
		id: 'github',
		title: 'github',
		description: 'github OAuth integration',
		config: {
			name: 'github',
			clientId: 'github-client-id-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
		},
	})
	expect(detail).not.toHaveProperty('row')
})

test('resolveEntityDetail keeps integrations isolated by userId', async () => {
	mockModule.getJoinedIntegration.mockReset()
	mockModule.getJoinedIntegration.mockImplementation(
		async (input: { userId: string; name: string }) => {
			if (input.userId !== 'user-1' || input.name !== 'github') return null
			return createJoinedIntegration('github')
		},
	)
	mockModule.collectIntegrationPackageSuggestions.mockResolvedValue([])

	const agent = createAgent()
	await expect(
		resolveEntityDetail({
			agent,
			callerContext: agent.getCallerContext(),
			userId: 'user-2',
			username: 'other',
			entity: 'integration:github',
			searchRows: emptySearchRows() as never,
		}),
	).rejects.toThrow('Saved integration not found for this user.')

	expect(mockModule.getJoinedIntegration).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		userId: 'user-2',
		name: 'github',
	})
})

test('resolveEntityDetail hostedUrl uses PACKAGE_APP_BASE_URL when configured', async () => {
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.getSavedPackageByKodyId.mockResolvedValue({
		packageId: 'pkg-1',
		kodyId: 'demo',
		name: '@user/demo',
		description: 'Demo package',
		hasApp: true,
		sourceId: 'source-1',
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: { kody: {} },
		files: {},
	})

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	})
	const agent = {
		getEnv: () =>
			({
				APP_DB: {},
				PACKAGE_APP_BASE_URL: 'https://kody.run',
			}) as Env,
		getCallerContext: () => callerContext,
	} as unknown as McpRegistrationAgent

	const detail = await resolveEntityDetail({
		agent,
		callerContext,
		userId: 'user-1',
		username: 'kentcdodds',
		entity: 'package:demo',
		searchRows: emptySearchRows() as never,
	})

	expect(detail).toMatchObject({
		type: 'package',
		hostedUrl: 'https://kentcdodds.kody.run/packages/demo',
		baseUrl: 'https://heykody.dev',
		listingAhead: null,
	})
})

test('resolveEntityDetail passes package export fragments and hidden known-id packages', async () => {
	const hiddenRecord = {
		id: 'pkg-hidden',
		packageId: 'pkg-hidden',
		kodyId: 'home-controls',
		name: '@user/home-controls',
		description: 'Hidden home controls',
		hasApp: false,
		hidden: true,
		sourceId: 'source-hidden',
		userId: 'user-1',
		tags: [],
		searchText: null,
		isPrivate: false,
		createdAt: '2026-03-20T00:00:00.000Z',
		updatedAt: '2026-03-20T00:00:00.000Z',
	}
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.getSavedPackageByKodyId.mockResolvedValue(hiddenRecord)
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: {
			name: '@user/home-controls',
			exports: { './bond-area-shades': './src/bond-area-shades.ts' },
			kody: { id: 'home-controls', description: 'Hidden home controls' },
		},
		files: {
			'src/bond-area-shades.ts':
				'/** Lower shades. */\nexport default async function bondAreaShades() { return true }',
		},
	})

	const agent = createAgent()
	const hashed = await resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: 'user-1',
		username: 'user',
		entity: 'package:home-controls#bond-area-shades',
		searchRows: emptySearchRows() as never,
	})
	expect(hashed).toMatchObject({
		type: 'package',
		id: 'home-controls',
		section: 'bond-area-shades',
		record: expect.objectContaining({ hidden: true }),
	})

	const dotted = await resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: 'user-1',
		username: 'user',
		entity: 'package:home-controls#./bond-area-shades',
		searchRows: emptySearchRows() as never,
	})
	expect(dotted).toMatchObject({
		type: 'package',
		section: './bond-area-shades',
	})
})
