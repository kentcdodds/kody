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
			name: '_scratch:notes',
			scope: 'user' as const,
			value: 'todo',
			description: 'Scratch notes',
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

test('values API lists, selects, saves, and deletes user-scoped values', async () => {
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
			{
				id: '_scratch:notes',
				name: '_scratch:notes',
				description: 'Scratch notes',
				valuePreview: 'todo',
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

	const selectedResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/values.json?selected=theme',
		),
	})
	expect(selectedResponse.status).toBe(200)
	await expect(selectedResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedValueId: 'theme',
		selectedValue: expect.objectContaining({
			id: 'theme',
			name: 'theme',
			value: 'dark',
		}),
	})

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
	expect(await saveResponse.json()).toMatchObject({
		ok: true,
		selectedValueId: 'locale',
		selectedValue: expect.objectContaining({ id: 'locale', value: 'en-US' }),
	})

	mockModule.listValues.mockResolvedValueOnce([])
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

test('values API rejects missing deletes, invalid actions, and unauthenticated requests', async () => {
	const handler = createAccountValuesApiHandler(createEnv())
	mockModule.saveValue.mockClear()
	mockModule.deleteValue.mockClear()

	mockModule.saveValue.mockResolvedValueOnce({
		name: '_scratch:notes',
		scope: 'user' as const,
		value: 'updated',
		description: 'Scratch notes',
		appId: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		ttlMs: null,
	})
	mockModule.listValues.mockResolvedValueOnce([
		{
			name: '_scratch:notes',
			scope: 'user' as const,
			value: 'updated',
			description: 'Scratch notes',
			appId: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			ttlMs: null,
		},
	])
	const underscoreSave = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'save',
				name: '_scratch:notes',
				value: 'updated',
				description: 'Scratch notes',
			}),
		}),
	})
	expect(underscoreSave.status).toBe(200)
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({ name: '_scratch:notes' }),
	)

	mockModule.deleteValue.mockResolvedValueOnce(false)
	const missingDelete = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				name: 'missing',
			}),
		}),
	})
	expect(missingDelete.status).toBe(404)
	await expect(missingDelete.json()).resolves.toMatchObject({ ok: false })

	const invalid = await handler.handler({
		request: new Request('https://example.com/account/values.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'nope' }),
		}),
	})
	expect(invalid.status).toBe(400)
	await expect(invalid.json()).resolves.toMatchObject({ ok: false })

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const unauthorized = await handler.handler({
		request: new Request('https://example.com/account/values.json'),
	})
	expect(unauthorized.status).toBe(401)
})
