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
	deleteValue: (...args: Array<unknown>) => mockModule.deleteValue(...args),
}))

const { createAccountValuesApiHandler } = await import('./account-values.ts')

const valuesUrl = 'https://example.com/account/values.json'

function createValuesClient() {
	const { handler } = createAccountValuesApiHandler({
		APP_DB: {} as D1Database,
	} as Env)
	return {
		get: (search = '') => handler({ request: new Request(valuesUrl + search) }),
		post: (body: Record<string, unknown>) =>
			handler({
				request: new Request(valuesUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
			}),
	}
}

test('values API lists, selects, and deletes leftover user-scoped rows', async () => {
	const { get, post } = createValuesClient()

	const listResponse = await get()
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

	const selectedResponse = await get('?selected=theme')
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

	mockModule.listValues.mockResolvedValueOnce([])
	const deleteResponse = await post({ action: 'delete', name: 'theme' })
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

test('values API rejects save, missing deletes, invalid actions, and unauthenticated requests', async () => {
	const { get, post } = createValuesClient()

	const rejections = [
		[
			{ action: 'save', name: 'locale', value: 'en-US' },
			400,
			{ ok: false, error: 'Invalid action.' },
		],
		[{ action: 'delete', name: 'missing' }, 404, { ok: false }],
		[{ action: 'nope' }, 400, { ok: false }],
	] as const
	for (const [body, status, want] of rejections) {
		if (status === 404) mockModule.deleteValue.mockResolvedValueOnce(false)
		const response = await post(body)
		expect([body, response.status, await response.json()]).toEqual([
			body,
			status,
			expect.objectContaining(want),
		])
	}

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	expect((await get()).status).toBe(401)
})
