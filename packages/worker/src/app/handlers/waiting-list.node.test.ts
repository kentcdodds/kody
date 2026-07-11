import { afterEach, expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createWaitingListHandler,
	waitingListRateLimitConfig,
} from '#app/handlers/waiting-list.ts'
import { DEFAULT_KIT_WAITLIST_TAG_ID } from '#app/kit-waitlist.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	logAuditEventSpy.mockClear()
	consoleError.mockClear()
})

function createRateLimitDb() {
	const rows: Array<{ id: number; key: string; ts: number }> = []
	let nextId = 1

	async function runStatement(statement: {
		query?: string
		binds?: unknown[]
	}) {
		const query = statement.query ?? ''
		const binds = statement.binds ?? []

		if (query.includes('CREATE TABLE') || query.includes('CREATE INDEX')) {
			return { meta: { changes: 0, last_row_id: 0 } }
		}
		if (query.includes('DELETE FROM _rate_limits WHERE ts <=')) {
			const windowStart = Number(binds[0])
			const before = rows.length
			for (let i = rows.length - 1; i >= 0; i--) {
				if ((rows[i]?.ts ?? 0) <= windowStart) rows.splice(i, 1)
			}
			return { meta: { changes: before - rows.length, last_row_id: 0 } }
		}
		if (
			query.includes('DELETE FROM _rate_limits') &&
			query.includes('ORDER BY id DESC')
		) {
			const key = String(binds[0])
			const index = [...rows].reverse().findIndex((row) => row.key === key)
			if (index === -1) return { meta: { changes: 0, last_row_id: 0 } }
			const actualIndex = rows.length - 1 - index
			rows.splice(actualIndex, 1)
			return { meta: { changes: 1, last_row_id: 0 } }
		}
		if (query.includes('INSERT INTO _rate_limits')) {
			const key = String(binds[0])
			const now = Number(binds[1])
			const windowStart = Number(binds[3])
			const maxRequests = Number(binds[4])
			const count = rows.filter(
				(row) => row.key === key && row.ts > windowStart,
			).length
			if (count >= maxRequests) {
				return { meta: { changes: 0, last_row_id: 0 } }
			}
			const id = nextId++
			rows.push({ id, key, ts: now })
			return { meta: { changes: 1, last_row_id: id } }
		}
		return { meta: { changes: 0, last_row_id: 0 } }
	}

	const db = {
		async batch(
			statements: Array<{
				query?: string
				binds?: unknown[]
				run?: () => Promise<unknown>
			}>,
		) {
			const results = []
			for (const statement of statements) {
				results.push(await runStatement(statement))
			}
			return results
		},
		prepare(query: string) {
			const statement = {
				query,
				binds: [] as unknown[],
				bind(...binds: unknown[]) {
					statement.binds = binds
					return statement
				},
				async run() {
					return runStatement(statement)
				},
			}
			return statement
		},
	}

	return {
		db: db as unknown as D1Database,
		get attemptCount() {
			return rows.length
		},
	}
}

function createHandler(envOverrides: Record<string, unknown> = {}) {
	const rateLimitDb = createRateLimitDb()
	const handler = createWaitingListHandler({
		APP_DB: rateLimitDb.db,
		SENTRY_ENVIRONMENT: 'production',
		...envOverrides,
	} as unknown as Env)
	return { handler, rateLimitDb }
}

async function postWaitingList(
	handler: ReturnType<typeof createWaitingListHandler>,
	body: unknown,
	headers: HeadersInit = {},
) {
	const request = new Request('http://example.com/waiting-list', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	const context = new RequestContext(request)
	return handler.handler(context)
}

test('joins the Kit waitlist with first name and email', async () => {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/subscribers?email_address=')) {
				return Response.json({ subscribers: [] }, { status: 200 })
			}
			if (url.endsWith('/subscribers') && method === 'POST') {
				return Response.json(
					{ subscriber: { id: 42, email_address: 'ada@example.com' } },
					{ status: 201 },
				)
			}
			if (url.includes(`/tags/${DEFAULT_KIT_WAITLIST_TAG_ID}/subscribers`)) {
				return Response.json(
					{ subscriber: { id: 42, email_address: 'ada@example.com' } },
					{ status: 201 },
				)
			}
			return Response.json({ errors: ['unexpected'] }, { status: 500 })
		},
	)
	vi.stubGlobal('fetch', fetchMock)

	const { handler } = createHandler({
		KIT_API_KEY: 'kit-test-key',
	})
	const response = await postWaitingList(handler, {
		firstName: '  Ada  Lovelace ',
		email: 'Ada@Example.com',
	})

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		message: "You're on the list. We'll be in touch.",
	})
	expect(fetchMock).toHaveBeenCalledTimes(3)
	const createCall = fetchMock.mock.calls.find(([url, init]) => {
		return (
			String(url).endsWith('/subscribers') &&
			(init as RequestInit | undefined)?.method === 'POST'
		)
	})
	expect(createCall?.[1]?.headers).toMatchObject({
		'X-Kit-Api-Key': 'kit-test-key',
	})
	expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
		email_address: 'ada@example.com',
		first_name: 'Ada Lovelace',
	})
	expect(auditEventSummaries()).toEqual(['waiting_list_join:success'])
})

test('rejects missing first name and invalid email', async () => {
	const { handler } = createHandler({ KIT_API_KEY: 'kit-test-key' })

	const missingName = await postWaitingList(handler, {
		firstName: '   ',
		email: 'ada@example.com',
	})
	expect(missingName.status).toBe(400)
	expect(await missingName.json()).toEqual({
		ok: false,
		error: 'First name is required.',
	})

	const badEmail = await postWaitingList(handler, {
		firstName: 'Ada',
		email: 'not-an-email',
	})
	expect(badEmail.status).toBe(400)
	expect(await badEmail.json()).toEqual({
		ok: false,
		error: 'A valid email is required.',
	})
})

test('fails closed in production when Kit is not configured', async () => {
	const { handler } = createHandler({
		SENTRY_ENVIRONMENT: 'production',
	})
	const response = await postWaitingList(handler, {
		firstName: 'Ada',
		email: 'ada@example.com',
	})
	expect(response.status).toBe(503)
	expect(await response.json()).toEqual({
		ok: false,
		error:
			'Waiting list signup is temporarily unavailable. Please try again later.',
	})
})

test('no-ops successfully in non-production without a Kit key', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	const { handler } = createHandler({
		SENTRY_ENVIRONMENT: 'test',
	})
	const response = await postWaitingList(handler, {
		firstName: 'Ada',
		email: 'ada@example.com',
	})
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({ ok: true })
	expect(fetchMock).not.toHaveBeenCalled()
	expect(auditEventSummaries()).toEqual(['waiting_list_join:success'])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'waiting_list_join',
			result: 'success',
			reason: 'kit_skipped_non_production',
		}),
	)
})

test('rate limits repeated waiting list submissions', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/subscribers?email_address=')) {
				return Response.json({ subscribers: [] }, { status: 200 })
			}
			if (url.endsWith('/subscribers') && method === 'POST') {
				return Response.json({ subscriber: { id: 1 } }, { status: 201 })
			}
			return Response.json({ subscriber: { id: 1 } }, { status: 201 })
		}),
	)
	const { handler, rateLimitDb } = createHandler({
		KIT_API_KEY: 'kit-test-key',
	})

	for (let i = 0; i < waitingListRateLimitConfig.maxRequests; i++) {
		const response = await postWaitingList(
			handler,
			{ firstName: 'Ada', email: `ada${i}@example.com` },
			{ 'CF-Connecting-IP': '203.0.113.10' },
		)
		expect(response.status).toBe(200)
	}

	const limited = await postWaitingList(
		handler,
		{ firstName: 'Ada', email: 'ada-extra@example.com' },
		{ 'CF-Connecting-IP': '203.0.113.10' },
	)
	expect(limited.status).toBe(429)
	expect(limited.headers.get('Retry-After')).toBeTruthy()
	expect(rateLimitDb.attemptCount).toBe(waitingListRateLimitConfig.maxRequests)
})

test('refunds the rate-limit slot when Kit subscribe fails transiently', async () => {
	consoleError.mockImplementation(() => {})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ errors: ['boom'] }, { status: 500 })),
	)
	const { handler, rateLimitDb } = createHandler({
		KIT_API_KEY: 'kit-test-key',
	})
	const response = await postWaitingList(handler, {
		firstName: 'Ada',
		email: 'ada@example.com',
	})
	expect(response.status).toBe(502)
	expect(rateLimitDb.attemptCount).toBe(0)
	expect(consoleError).toHaveBeenCalled()
})

test('keeps the rate-limit slot when Kit rejects with a client error', async () => {
	consoleError.mockImplementation(() => {})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({ errors: ['invalid email'] }, { status: 422 }),
		),
	)
	const { handler, rateLimitDb } = createHandler({
		KIT_API_KEY: 'kit-test-key',
	})
	const response = await postWaitingList(handler, {
		firstName: 'Ada',
		email: 'ada@example.com',
	})
	expect(response.status).toBe(502)
	expect(rateLimitDb.attemptCount).toBe(1)
	expect(consoleError).toHaveBeenCalled()
})
