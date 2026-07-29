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

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
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
		app: {
			userId: 'user-1',
			slug: name,
			provider: name,
			label: null,
			clientId: `${name}-client-id-value`,
			clientSecretSecretName: `${name}-client-secret`,
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
			accountLabel: null,
			description: `${name} OAuth integration`,
			scopes: ['repo'],
			requiredHosts: ['api.github.com'],
			accessTokenSecretName: `${name}-access-token`,
			refreshTokenSecretName: null,
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
		['nope:capability', 'Capability not found.'],
		['user:missing-value:value', 'Persisted value not found for this user.'],
		['notion:integration', 'Saved integration not found for this user.'],
		['API_KEY:secret', 'Secret not found for this user.'],
		[
			'not-a-ref',
			'Entity must use the format "{id}:{type}" where type is capability, package, secret, value, or integration.',
		],
		[
			'thing:widget',
			'Entity type must be one of: capability, package, secret, value, or integration.',
		],
		[
			'workspace:preferred_repo:value',
			'Value entity scope must be one of: session, app, or user.',
		],
	] as const

	for (const [entity, message] of expected) {
		const detail = resolve(entity)
		await expect(detail).rejects.toThrow(McpCallerError)
		await expect(detail).rejects.toThrow(message)
	}
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
		entity: 'github:integration',
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
			clientSecretSecretName: 'github-client-secret',
			accessTokenSecretName: 'github-access-token',
			tokenUrl: 'https://github.com/login/oauth/access_token',
		},
	})
	expect(detail).not.toHaveProperty('row')
	expect(JSON.stringify(detail)).not.toContain('secret-value')
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
			entity: 'github:integration',
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
				PACKAGE_APP_BASE_URL: 'https://kodyapps.dev',
			}) as Env,
		getCallerContext: () => callerContext,
	} as unknown as McpRegistrationAgent

	const detail = await resolveEntityDetail({
		agent,
		callerContext,
		userId: 'user-1',
		username: 'kentcdodds',
		entity: 'demo:package',
		searchRows: emptySearchRows() as never,
	})

	expect(detail).toMatchObject({
		type: 'package',
		hostedUrl: 'https://kodyapps.dev/@kentcdodds/packages/demo',
		baseUrl: 'https://heykody.dev',
	})
})
