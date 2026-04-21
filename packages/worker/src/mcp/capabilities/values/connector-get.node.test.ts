import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getValue: vi.fn(),
	listUserSecretsForSearch: vi.fn(),
}))

vi.mock('#mcp/values/service.ts', () => ({
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (...args: Array<unknown>) =>
		mockModule.listUserSecretsForSearch(...args),
}))

const { connectorGetCapability } = await import('./connector-get.ts')

beforeEach(() => {
	vi.clearAllMocks()
})

test('connector_get includes readiness showing missing authenticated prerequisites', async () => {
	mockModule.getValue.mockImplementation(async (input: {
		name: string
	}) => {
		if (input.name === '_connector:spotify') {
			return {
				name: '_connector:spotify',
				scope: 'user',
				value: JSON.stringify({
					name: 'spotify',
					tokenUrl: 'https://accounts.spotify.com/api/token',
					apiBaseUrl: 'https://api.spotify.com/v1',
					flow: 'pkce',
					clientIdValueName: 'spotify-client-id',
					clientSecretSecretName: null,
					accessTokenSecretName: 'spotify-access-token',
					refreshTokenSecretName: 'spotify-refresh-token',
					requiredHosts: ['api.spotify.com'],
				}),
				description: 'Spotify connector',
				appId: null,
				createdAt: '2026-04-21T00:00:00.000Z',
				updatedAt: '2026-04-21T00:00:00.000Z',
				ttlMs: null,
			}
		}
		if (input.name === 'spotify-client-id') {
			return {
				name: 'spotify-client-id',
				scope: 'user',
				value: 'client-id-123',
				description: 'Spotify client id',
				appId: null,
				createdAt: '2026-04-21T00:00:00.000Z',
				updatedAt: '2026-04-21T00:00:00.000Z',
				ttlMs: null,
			}
		}
		return null
	})
	mockModule.listUserSecretsForSearch.mockResolvedValue([
		{
			name: 'spotify-access-token',
			scope: 'user',
			description: 'Access token',
			appId: null,
			updatedAt: '2026-04-21T00:00:00.000Z',
		},
	])

	const result = await connectorGetCapability.handler(
		{ name: 'spotify' },
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)

	expect(result.connector).toMatchObject({
		name: 'spotify',
		flow: 'pkce',
	})
	expect(result.readiness).toEqual({
		status: 'missing_prerequisites',
		authenticatedRequestsReady: false,
		available: {
			clientIdValue: true,
			accessTokenSecret: true,
			refreshTokenSecret: false,
			clientSecretSecret: null,
		},
		missingPrerequisites: [
			{
				kind: 'secret',
				requirement: 'refresh_token',
				name: 'spotify-refresh-token',
			},
		],
	})
})

test('connector_get returns null connector and readiness when config is missing', async () => {
	mockModule.getValue.mockResolvedValue(null)

	const result = await connectorGetCapability.handler(
		{ name: 'spotify' },
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)

	expect(result).toEqual({
		connector: null,
		readiness: null,
	})
	expect(mockModule.listUserSecretsForSearch).not.toHaveBeenCalled()
})
