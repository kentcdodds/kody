import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	backfillStableUserIds,
	handleSecretMaintenanceRequest,
	handleStableUserIdBackfillRequest,
} from './maintenance-handler.ts'

function createRequest(
	input: { method?: string; authorization?: string; path?: string } = {},
) {
	return new Request(`http://localhost${input.path ?? '/__maintenance/test'}`, {
		method: input.method ?? 'POST',
		headers:
			input.authorization === undefined
				? undefined
				: { Authorization: input.authorization },
	})
}

test('handleSecretMaintenanceRequest enforces auth and reports maintenance results', async () => {
	let runCount = 0
	const run = async () => {
		runCount += 1
		return { upserted: runCount }
	}

	const methodResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ method: 'GET', authorization: 'Bearer secret' }),
		secret: 'secret',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(methodResponse.status).toBe(405)
	expect(await methodResponse.text()).toBe('Method Not Allowed')

	const configurationResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: ' ',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(configurationResponse.status).toBe(503)
	expect(await configurationResponse.text()).toBe('Not configured')

	for (const authorization of [undefined, 'Bearer wrong']) {
		const response = await handleSecretMaintenanceRequest({
			request: createRequest({ authorization }),
			secret: 'secret',
			notConfiguredMessage: 'Not configured',
			run,
		})

		expect(response.status).toBe(401)
		expect(await response.text()).toBe('Unauthorized')
	}

	expect(runCount).toBe(0)

	const successResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: ' secret ',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(successResponse.status).toBe(200)
	await expect(successResponse.json()).resolves.toEqual({
		ok: true,
		upserted: 1,
	})
	expect(runCount).toBe(1)

	const errorResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: 'secret',
		notConfiguredMessage: 'Not configured',
		run: async () => {
			throw new Error('boom')
		},
	})

	expect(errorResponse.status).toBe(500)
	await expect(errorResponse.json()).resolves.toEqual({
		ok: false,
		error: 'boom',
	})
})

type BackfillUserRow = {
	id: number
	email: string
	stable_user_id: string | null
}

function createBackfillTestDb(input: {
	users: Array<BackfillUserRow>
	failingIds?: ReadonlySet<number>
}) {
	const users = input.users.map((user) => ({ ...user }))
	const selectPages: Array<number> = []
	const db = {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async all() {
							if (!normalized.startsWith('select')) {
								throw new Error(`Unsupported all query: ${query}`)
							}
							const afterId = Number(params[0])
							const limit = Number(params[1])
							const page = users
								.filter((user) => user.id > afterId)
								.sort((left, right) => left.id - right.id)
								.slice(0, limit)
								.map((user) => ({ ...user }))
							selectPages.push(page.length)
							return { results: page }
						},
						async run() {
							if (!normalized.startsWith('update users set stable_user_id')) {
								throw new Error(`Unsupported run query: ${query}`)
							}
							const id = Number(params[1])
							if (input.failingIds?.has(id)) {
								throw new Error(`UNIQUE constraint failed for user ${id}`)
							}
							const user = users.find(
								(candidate) =>
									candidate.id === id && candidate.stable_user_id === null,
							)
							if (user) user.stable_user_id = String(params[0])
							return { meta: { changes: user ? 1 : 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { db, users, selectPages }
}

test('backfillStableUserIds pages with a keyset and only touches NULL rows', async () => {
	const alreadyStored = 'stored-stable-id'
	const rows: Array<BackfillUserRow> = Array.from(
		{ length: 250 },
		(_, index) => ({
			id: index + 1,
			email: `backfill-${index + 1}@example.com`,
			stable_user_id: index % 5 === 0 ? alreadyStored : null,
		}),
	)
	const { db, users, selectPages } = createBackfillTestDb({ users: rows })

	const result = await backfillStableUserIds({ db })

	expect(result).toEqual({ scanned: 250, backfilled: 200, failed: 0 })
	// Keyset paging in batches of 100: two full pages and a final short one.
	expect(selectPages).toEqual([100, 100, 50])
	expect(users[0]?.stable_user_id).toBe(alreadyStored)
	expect(users[1]?.stable_user_id).toBe(
		await createStableUserIdFromEmail('backfill-2@example.com'),
	)
	expect(users.every((user) => user.stable_user_id !== null)).toBe(true)

	// Idempotent: a second run finds nothing left to backfill.
	expect(await backfillStableUserIds({ db })).toEqual({
		scanned: 250,
		backfilled: 0,
		failed: 0,
	})
})

test('backfillStableUserIds counts per-row failures without aborting', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db, users } = createBackfillTestDb({
		users: [
			{ id: 1, email: 'ok@example.com', stable_user_id: null },
			{ id: 2, email: 'collides@example.com', stable_user_id: null },
			{ id: 3, email: 'also-ok@example.com', stable_user_id: null },
		],
		failingIds: new Set([2]),
	})

	const result = await backfillStableUserIds({ db })

	expect(result).toEqual({ scanned: 3, backfilled: 2, failed: 1 })
	expect(users[1]?.stable_user_id).toBeNull()
	expect(users[2]?.stable_user_id).not.toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'stable-user-id-backfill-row-failed',
		2,
		expect.any(Error),
	)
})

test('handleStableUserIdBackfillRequest enforces the maintenance auth pattern', async () => {
	const { db } = createBackfillTestDb({
		users: [{ id: 1, email: 'route@example.com', stable_user_id: null }],
	})
	const path = '/__maintenance/backfill-stable-user-ids'

	const notConfiguredResponse = await handleStableUserIdBackfillRequest(
		createRequest({ path, authorization: 'Bearer secret' }),
		{ APP_DB: db, CAPABILITY_REINDEX_SECRET: undefined },
	)
	expect(notConfiguredResponse.status).toBe(503)

	const unauthorizedResponse = await handleStableUserIdBackfillRequest(
		createRequest({ path, authorization: 'Bearer wrong' }),
		{ APP_DB: db, CAPABILITY_REINDEX_SECRET: 'secret' },
	)
	expect(unauthorizedResponse.status).toBe(401)

	const successResponse = await handleStableUserIdBackfillRequest(
		createRequest({ path, authorization: 'Bearer secret' }),
		{ APP_DB: db, CAPABILITY_REINDEX_SECRET: 'secret' },
	)
	expect(successResponse.status).toBe(200)
	await expect(successResponse.json()).resolves.toEqual({
		ok: true,
		scanned: 1,
		backfilled: 1,
		failed: 0,
	})
})
