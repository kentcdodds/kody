import { expect, test, vi } from 'vitest'
import { buildMemoriesExportFilename } from '#universal/memory-export.ts'

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
	const memoryDbRow = {
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
	}
	return {
		memoryRow,
		memoryDbRow,
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
		listMemoriesByUserId: vi.fn(async () => [memoryDbRow]),
		listMemoriesByUserIdPage: vi.fn(async () => [memoryDbRow]),
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
	listMemoriesByUserIdPage: (...args: Array<unknown>) =>
		mockModule.listMemoriesByUserIdPage(...args),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	getMemory: (...args: Array<unknown>) => mockModule.getMemory(...args),
	deleteMemory: (...args: Array<unknown>) => mockModule.deleteMemory(...args),
}))

const { createAccountMemoriesApiHandler, createAccountMemoriesExportHandler } =
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

test('memories export filename uses the UTC calendar date', () => {
	expect(
		buildMemoriesExportFilename(new Date('2026-08-31T23:30:00.000Z')),
	).toBe('kody-memories-2026-08-31.json')
})

test('memories export downloads the signed-in user memories as JSON', async () => {
	const handler = createAccountMemoriesExportHandler(createEnv())

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const unauthorized = await handler.handler({
		request: new Request('https://example.com/account/memories-export.json'),
		params: {},
	} as never)
	expect(unauthorized.status).toBe(401)

	const defaultExport = await handler.handler({
		request: new Request('https://example.com/account/memories-export.json'),
		params: {},
	} as never)
	expect(defaultExport.status).toBe(200)
	expect(defaultExport.headers.get('Cache-Control')).toBe('no-store')
	expect(defaultExport.headers.get('Content-Type')).toBe(
		'application/json; charset=utf-8',
	)
	expect(defaultExport.headers.get('Content-Disposition')).toMatch(
		/^attachment; filename="kody-memories-\d{4}-\d{2}-\d{2}\.json"$/,
	)
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			afterId: null,
			statuses: ['active', 'archived'],
			limit: 200,
		}),
	)
	const payload = (await defaultExport.json()) as {
		kind: string
		version: number
		exportedAt: string
		includeDeleted: boolean
		memories: Array<Record<string, unknown>>
	}
	expect(payload.kind).toBe('kody-memories')
	expect(payload.version).toBe(1)
	expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(payload.includeDeleted).toBe(false)
	expect(payload.memories).toEqual([
		{
			id: memoryRow.id,
			subject: memoryRow.subject,
			category: memoryRow.category,
			status: memoryRow.status,
			tags: memoryRow.tags,
			summary: memoryRow.summary,
			details: memoryRow.details,
			sourceUris: memoryRow.sourceUris,
			dedupeKey: memoryRow.dedupeKey,
			createdAt: memoryRow.createdAt,
			updatedAt: memoryRow.updatedAt,
			lastAccessedAt: memoryRow.lastAccessedAt,
			deletedAt: memoryRow.deletedAt,
		},
	])
	expect(JSON.stringify(payload)).not.toContain('user@example.com')
	expect(JSON.stringify(payload)).not.toContain('stable-user-1')
	expect(payload.memories[0]).not.toHaveProperty('user_id')
	expect(payload.memories[0]).not.toHaveProperty('userId')

	mockModule.listMemoriesByUserIdPage.mockClear()
	const withDeleted = await handler.handler({
		request: new Request(
			'https://example.com/account/memories-export.json?includeDeleted=true',
		),
		params: {},
	} as never)
	expect(withDeleted.status).toBe(200)
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenCalledWith(
		expect.objectContaining({
			statuses: ['active', 'archived', 'deleted'],
		}),
	)
	const deletedPayload = (await withDeleted.json()) as {
		includeDeleted: boolean
	}
	expect(deletedPayload.includeDeleted).toBe(true)

	const firstPage = Array.from({ length: 200 }, (_, index) => ({
		...mockModule.memoryDbRow,
		id: `page-1-${String(index).padStart(3, '0')}`,
	}))
	mockModule.listMemoriesByUserIdPage
		.mockResolvedValueOnce(firstPage)
		.mockResolvedValueOnce([{ ...mockModule.memoryDbRow, id: 'page-2-000' }])
	const paged = await handler.handler({
		request: new Request('https://example.com/account/memories-export.json'),
		params: {},
	} as never)
	const pagedPayload = (await paged.json()) as {
		memories: Array<{ id: string }>
	}
	expect(pagedPayload.memories).toHaveLength(201)
	expect(pagedPayload.memories.at(-1)?.id).toBe('page-2-000')
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			afterId: 'page-1-199',
		}),
	)

	const disallowed = await handler.handler({
		request: new Request('https://example.com/account/memories-export.json', {
			method: 'POST',
		}),
		params: {},
	} as never)
	expect(disallowed.status).toBe(405)
})
