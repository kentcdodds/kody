import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: async () => {
		return {
			sessionUserId: '42',
			userId: 42,
			email: 'user@example.com',
			displayName: 'user',
			artifactOwnerIds: ['owner-1'],
			mcpUser: {
				userId: 'stable-user-1',
				email: 'user@example.com',
				displayName: 'user',
			},
		}
	},
	getAppBaseUrl: () => 'https://example.com',
	createGeneratedUiAppSession: async (input: { appId?: string | null }) => ({
		token: 'generated-token',
		sessionId: 'session-1',
		endpoints: {
			secrets: 'https://example.com/ui-api/session-1/secrets',
			deleteSecret: 'https://example.com/ui-api/session-1/secrets/delete',
			execute: 'https://example.com/ui-api/session-1/execute',
			source: 'https://example.com/ui-api/session-1/source',
		},
		appId: input.appId ?? null,
	}),
	verifyGeneratedUiAppSession: async () => ({
		session_id: 'session-1',
		app_id: null,
		user: { userId: 'stable-user-1' },
	}),
	resolveSecret: vi.fn(async () => ({
		found: true,
		allowedHosts: [],
		allowedCapabilities: [],
	})),
	saveSecret: vi.fn(async () => ({
		name: 'linearApiKey',
		scope: 'user',
		description: '',
		appId: null,
		allowedHosts: [],
		allowedCapabilities: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		ttlMs: null,
	})),
	setSecretAllowedHosts: vi.fn(async () => undefined),
	setSecretAllowedCapabilities: vi.fn(async () => undefined),
	saveValue: vi.fn(async () => undefined),
	getSavedPackageById: async (_db: D1Database, input: { packageId: string }) =>
		input.packageId === 'package-123'
			? {
					id: 'package-123',
					userId: 'stable-user-1',
					name: '@kody/example-package',
					kodyId: 'example-package',
					description: 'Example package',
					tags: [],
					searchText: null,
					sourceId: 'source-package-123',
					hasApp: true,
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
				}
			: null,
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#app/layout.ts', () => ({
	Layout: () => null,
}))

vi.mock('#app/render.ts', () => ({
	render: () => new Response('ok'),
}))

vi.mock('#mcp/generated-ui-app-session.ts', () => ({
	createGeneratedUiAppSession: (...args: Array<unknown>) =>
		mockModule.createGeneratedUiAppSession(...args),
	verifyGeneratedUiAppSession: (...args: Array<unknown>) =>
		mockModule.verifyGeneratedUiAppSession(...args),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	capabilityMap: {
		linear_issue_list: true,
	},
}))

vi.mock('#mcp/secrets/allowed-hosts.ts', () => ({
	normalizeAllowedHosts: (hosts: Array<string>) => hosts,
}))

vi.mock('#mcp/secrets/allowed-capabilities.ts', () => ({
	normalizeAllowedCapabilities: (capabilities: Array<string>) => capabilities,
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecret: (...args: Array<unknown>) => mockModule.resolveSecret(...args),
	saveSecret: (...args: Array<unknown>) => mockModule.saveSecret(...args),
	setSecretAllowedHosts: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedHosts(...args),
	setSecretAllowedCapabilities: (...args: Array<unknown>) =>
		mockModule.setSecretAllowedCapabilities(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	saveValue: (...args: Array<unknown>) => mockModule.saveValue(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

const { createConnectSecretApiHandler } = await import('./connect-secret.ts')
function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

async function readJson(response: Response) {
	return (await response.json()) as { ok?: boolean; error?: string }
}

test('connect secret GET rejects app scope without appId', async () => {
	const handler = createConnectSecretApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/connect/secret.json?scope=app'),
		params: {},
	} as never)

	expect(response.status).toBe(400)
	await expect(readJson(response)).resolves.toEqual({
		ok: false,
		error: 'App scope requires an appId query parameter.',
	})
})

test('connect secret GET rejects unknown scope values', async () => {
	const handler = createConnectSecretApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/connect/secret.json?scope=sessions',
		),
		params: {},
	} as never)

	expect(response.status).toBe(400)
	await expect(readJson(response)).resolves.toEqual({
		ok: false,
		error: 'Invalid secret scope.',
	})
})

test('connect secret GET creates app-scoped session with requested app id', async () => {
	const handler = createConnectSecretApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request(
			'https://example.com/connect/secret.json?scope=app&appId=package-123',
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(readJson(response)).resolves.toMatchObject({
		ok: true,
	})
})

test('connect secret POST rejects app scope when session is not app-scoped', async () => {
	const handler = createConnectSecretApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/connect/secret.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'linearApiKey',
				scope: 'app',
				sessionToken: 'generated-token',
				connector: 'linear',
				allowedCapabilities: ['linear_issue_list'],
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(400)
	await expect(readJson(response)).resolves.toEqual({
		ok: false,
		error: 'App scope requires an app-scoped session.',
	})
})

test('connect secret POST stores connector binding under dedicated prefix', async () => {
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		allowedHosts: ['api.linear.app'],
		allowedCapabilities: ['linear_issue_list'],
	})

	const handler = createConnectSecretApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/connect/secret.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'linearApiKey',
				scope: 'user',
				sessionToken: 'generated-token',
				connector: 'linear',
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(readJson(response)).resolves.toEqual({ ok: true })
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({
			name: '_connector-secret:linear',
			value: JSON.stringify({
				secretName: 'linearApiKey',
				allowedHosts: ['api.linear.app'],
				allowedCapabilities: ['linear_issue_list'],
			}),
			description: 'Connector secret binding for linear',
			scope: 'user',
			storageContext: { sessionId: 'session-1', appId: null },
		}),
	)
	expect(mockModule.saveValue).not.toHaveBeenCalledWith(
		expect.objectContaining({
			name: '_connector:linear',
		}),
	)
})

test('connect secret POST saves secret metadata from editable defaults', async () => {
	const handler = createConnectSecretApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/connect/secret.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'linearApiKey',
				scope: 'user',
				sessionToken: 'generated-token',
				value: 'shh-secret',
				description: 'Linear API key',
				allowedHosts: ['API.LINEAR.APP', 'api.linear.app'],
				allowedCapabilities: ['linear_issue_list'],
			}),
		}),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(readJson(response)).resolves.toEqual({ ok: true })
	expect(mockModule.saveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'linearApiKey',
			value: 'shh-secret',
			scope: 'user',
			description: 'Linear API key',
			storageContext: { sessionId: 'session-1', appId: null },
		}),
	)
	expect(mockModule.setSecretAllowedHosts).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'linearApiKey',
			scope: 'user',
			allowedHosts: ['API.LINEAR.APP', 'api.linear.app'],
			storageContext: { sessionId: 'session-1', appId: null },
		}),
	)
	expect(mockModule.setSecretAllowedCapabilities).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'linearApiKey',
			scope: 'user',
			allowedCapabilities: ['linear_issue_list'],
			storageContext: { sessionId: 'session-1', appId: null },
		}),
	)
})
