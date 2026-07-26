import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => {
	const memoryRow = {
		id: '11111111-1111-4111-8111-111111111111',
		category: 'preferences',
		status: 'active' as const,
		subject: 'Favorite editor',
		summary: 'Prefers VS Code for TypeScript work.',
		details: 'Uses the Remix extension and oxlint.',
		tags: ['editor', 'typescript'],
		sourceUris: ['https://example.com/notes/editor'],
		dedupeKey: 'prefs:editor',
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		lastAccessedAt: null as string | null,
		deletedAt: null as string | null,
	}
	return {
		memoryRow,
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
		listMemoriesByUserId: vi.fn(async () => [
			{
				id: memoryRow.id,
				user_id: 'stable-user-1',
				category: memoryRow.category,
				status: memoryRow.status,
				subject: memoryRow.subject,
				summary: memoryRow.summary,
				details: memoryRow.details,
				tags_json: JSON.stringify(memoryRow.tags),
				source_uris_json: JSON.stringify(memoryRow.sourceUris),
				dedupe_key: memoryRow.dedupeKey,
				created_at: memoryRow.createdAt,
				updated_at: memoryRow.updatedAt,
				last_accessed_at: memoryRow.lastAccessedAt,
				deleted_at: memoryRow.deletedAt,
			},
		]),
		getMemory: vi.fn(async () => memoryRow),
		deleteMemory: vi.fn(async () => ({
			...memoryRow,
			status: 'deleted' as const,
		})),
	}
})

const { memoryRow } = mockModule

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
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#mcp/memory/repo.ts', () => ({
	listMemoriesByUserId: (...args: Array<unknown>) =>
		mockModule.listMemoriesByUserId(...args),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	getMemory: (...args: Array<unknown>) => mockModule.getMemory(...args),
	deleteMemory: (...args: Array<unknown>) => mockModule.deleteMemory(...args),
}))

const { createAccountMemoriesApiHandler } =
	await import('./account-memories.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

test('memories API lists, filters, and selects user-scoped memories', async () => {
	const handler = createAccountMemoriesApiHandler(createEnv())

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/memories.json'),
		params: {},
	} as never)

	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.listMemoriesByUserId).toHaveBeenCalledWith(
		expect.anything(),
		'stable-user-1',
		expect.objectContaining({
			statuses: ['active', 'archived'],
			limit: 100,
		}),
	)
	await expect(listResponse.json()).resolves.toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		memories: [
			{
				id: memoryRow.id,
				subject: memoryRow.subject,
				category: memoryRow.category,
				status: memoryRow.status,
				tags: memoryRow.tags,
				summary: memoryRow.summary,
				updatedAt: memoryRow.updatedAt,
			},
		],
		selectedMemory: null,
		query: '',
		includeDeleted: false,
	})

	const filtered = await handler.handler({
		request: new Request(
			'https://example.com/account/memories.json?q=editor&includeDeleted=true&selected=11111111-1111-4111-8111-111111111111',
		),
		params: {},
	} as never)

	expect(filtered.status).toBe(200)
	expect(mockModule.listMemoriesByUserId).toHaveBeenCalledWith(
		expect.anything(),
		'stable-user-1',
		expect.objectContaining({
			statuses: ['active', 'archived', 'deleted'],
		}),
	)
	expect(mockModule.getMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			memoryId: memoryRow.id,
		}),
	)
	const payload = (await filtered.json()) as {
		ok: boolean
		query: string
		includeDeleted: boolean
		selectedMemory: { id: string; details: string } | null
	}
	expect(payload.ok).toBe(true)
	expect(payload.query).toBe('editor')
	expect(payload.includeDeleted).toBe(true)
	expect(payload.selectedMemory).toEqual(
		expect.objectContaining({
			id: memoryRow.id,
			details: memoryRow.details,
			sourceUris: memoryRow.sourceUris,
			dedupeKey: memoryRow.dedupeKey,
		}),
	)
})

test('memories API soft/force deletes and rejects invalid delete requests', async () => {
	const handler = createAccountMemoriesApiHandler(createEnv())

	const softResponse = await handler.handler({
		request: new Request('https://example.com/account/memories.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				memoryId: memoryRow.id,
			}),
		}),
		params: {},
	} as never)
	expect(softResponse.status).toBe(200)
	expect(mockModule.deleteMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			memoryId: memoryRow.id,
			force: false,
		}),
	)

	mockModule.deleteMemory.mockClear()
	const hardResponse = await handler.handler({
		request: new Request('https://example.com/account/memories.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				memoryId: memoryRow.id,
				force: true,
			}),
		}),
		params: {},
	} as never)
	expect(hardResponse.status).toBe(200)
	expect(mockModule.deleteMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			memoryId: memoryRow.id,
			force: true,
		}),
	)

	const missingId = await handler.handler({
		request: new Request('https://example.com/account/memories.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete' }),
		}),
		params: {},
	} as never)
	expect(missingId.status).toBe(400)

	const invalidAction = await handler.handler({
		request: new Request('https://example.com/account/memories.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'upsert' }),
		}),
		params: {},
	} as never)
	expect(invalidAction.status).toBe(400)

	mockModule.deleteMemory.mockResolvedValueOnce(null)
	const notFound = await handler.handler({
		request: new Request('https://example.com/account/memories.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				memoryId: 'missing',
			}),
		}),
		params: {},
	} as never)
	expect(notFound.status).toBe(404)
})
