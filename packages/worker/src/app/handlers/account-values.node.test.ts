import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	listValues: vi.fn(async () => [
		{
			name: 'theme',
			scope: 'user' as const,
			value: 'dark',
			description: 'UI theme preference',
			appId: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
		{
			name: '_integration:github',
			scope: 'user' as const,
			value: '{"clientId":"x"}',
			description: 'reserved',
			appId: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
		{
			name: '_openapi:widgets',
			scope: 'user' as const,
			value: '{"ops":[]}',
			description: 'reserved',
			appId: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	]),
	getValue: vi.fn(async () => null),
	saveValue: vi.fn(async () => ({
		name: 'locale',
		scope: 'user' as const,
		value: 'en-US',
		description: 'Preferred locale',
		appId: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		ttlMs: null,
	})),
	deleteValue: vi.fn(async () => true),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: (...args: Array<unknown>) =>
		mockModule.readAuthSessionResult(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
	saveValue: (...args: Array<unknown>) => mockModule.saveValue(...args),
	deleteValue: (...args: Array<unknown>) => mockModule.deleteValue(...args),
}))

const { createAccountValuesApiHandler } = await import('./account-values.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

test('values API lists user-scoped values and hides reserved prefixes', async () => {
	const handler = createAccountValuesApiHandler(createEnv())

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/values.json'),
	})

	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	await expect(listResponse.json()).resolves.toEqual({
		ok: true,
		values: [
			{
				id: 'theme',
				name: 'theme',
				description: 'UI theme preference',
				valuePreview: 'dark',
				updatedAt: new Date(0).toISOString(),
				ttlMs: null,
			},
		],
		selectedValue: null,
		selectedValueId: null,
	})
	expect(mockModule.listValues).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			scope: 'user',
			storageContext: { sessionId: null, appId: null },
		}),
	)
})

test('values API resolves selected value from selected query param', async () => {
	const handler = createAccountValuesApiHandler(createEnv())

	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/values.json?selected=theme',
		),
	})

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		values: [
			{
				id: 'theme',
				name: 'theme',
				description: 'UI theme preference',
				valuePreview: 'dark',
				updatedAt: new Date(0).toISOString(),
				ttlMs: null,
			},
		],
		selectedValue: {
			id: 'theme',
			name: 'theme',
			description: 'UI theme preference',
			value: 'dark',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
			scope: 'user',
		},
		selectedValueId: 'theme',
	})
})

test('values API saves a value and returns selectedValueId', async () => {
	mockModule.listValues.mockResolvedValueOnce([
		{
			name: 'locale',
			scope: 'user' as const,
			value: 'en-US',
			description: 'Preferred locale',
			appId: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	const handler = createAccountValuesApiHandler(createEnv())

	const saveResponse = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save',
				name: 'locale',
				value: 'en-US',
				description: 'Preferred locale',
			}),
		}),
	})

	expect(saveResponse.status).toBe(200)
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			scope: 'user',
			storageContext: { sessionId: null, appId: null },
			name: 'locale',
			value: 'en-US',
			description: 'Preferred locale',
			userEmail: 'user@example.com',
		}),
	)
	expect(await saveResponse.json()).toEqual({
		ok: true,
		selectedValueId: 'locale',
		selectedValue: {
			id: 'locale',
			name: 'locale',
			description: 'Preferred locale',
			value: 'en-US',
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
			scope: 'user',
		},
		values: [
			{
				id: 'locale',
				name: 'locale',
				description: 'Preferred locale',
				valuePreview: 'en-US',
				updatedAt: new Date(0).toISOString(),
				ttlMs: null,
			},
		],
	})
})

test('values API deletes a value by name', async () => {
	mockModule.listValues.mockResolvedValueOnce([])
	const handler = createAccountValuesApiHandler(createEnv())

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				name: 'theme',
			}),
		}),
	})

	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deleteValue).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			scope: 'user',
			storageContext: { sessionId: null, appId: null },
			name: 'theme',
		}),
	)
	await expect(deleteResponse.json()).resolves.toEqual({
		ok: true,
		values: [],
		selectedValue: null,
		selectedValueId: null,
	})
})

test('values API rejects save and delete for reserved names without mutating', async () => {
	const handler = createAccountValuesApiHandler(createEnv())
	mockModule.saveValue.mockClear()
	mockModule.deleteValue.mockClear()

	const saveResponse = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save',
				name: '_integration:github',
				value: '{"clientId":"x"}',
				description: 'should not save',
			}),
		}),
	})
	expect(saveResponse.status).toBe(400)
	await expect(saveResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('reserved'),
	})
	expect(mockModule.saveValue).not.toHaveBeenCalled()

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				name: '_integration:github',
			}),
		}),
	})
	expect(deleteResponse.status).toBe(400)
	await expect(deleteResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('reserved'),
	})
	expect(mockModule.deleteValue).not.toHaveBeenCalled()
})

test('values API returns 404 when deleting a missing value', async () => {
	mockModule.deleteValue.mockResolvedValueOnce(false)
	const handler = createAccountValuesApiHandler(createEnv())

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				name: 'missing',
			}),
		}),
	})

	expect(deleteResponse.status).toBe(404)
	await expect(deleteResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Value not found.',
	})
})

test('values API rejects invalid actions and unauthenticated requests', async () => {
	const handler = createAccountValuesApiHandler(createEnv())

	const invalid = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'nope' }),
		}),
	})
	expect(invalid.status).toBe(400)
	await expect(invalid.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid action.',
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const unauthorized = await handler.handler({
		request: new Request('https://example.com/account/values.json'),
	})
	expect(unauthorized.status).toBe(401)
})
