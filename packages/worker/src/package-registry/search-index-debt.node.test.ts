import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	upsertSavedPackageVector: vi.fn(),
	captureException: vi.fn(),
}))

vi.mock('./vectorize.ts', () => ({
	upsertSavedPackageVector: mockModule.upsertSavedPackageVector,
}))

vi.mock('@sentry/cloudflare', () => ({
	captureException: mockModule.captureException,
}))

import { scheduleSavedPackageSearchIndexUpsert } from './search-index-debt.ts'

type DebtRow = {
	packageId: string
	userId: string
	generation: number
	embedText: string
	lastError: string | null
}

function createDebtDb() {
	const rows = new Map<string, DebtRow>()
	return {
		rows,
		db: {
			prepare(sql: string) {
				return {
					bind(...values: Array<unknown>) {
						return {
							async run() {
								if (
									sql.includes('INSERT INTO saved_package_search_index_debt')
								) {
									const packageId = String(values[0])
									const existing = rows.get(packageId)
									rows.set(packageId, {
										packageId,
										userId: String(values[1]),
										generation: existing ? existing.generation + 1 : 1,
										embedText: String(values[2]),
										lastError: values[3] == null ? null : String(values[3]),
									})
								}
								if (
									sql.includes('UPDATE saved_package_search_index_debt') &&
									sql.includes('last_error')
								) {
									const packageId = String(values[2])
									const generation = Number(values[3])
									const existing = rows.get(packageId)
									if (existing && existing.generation === generation) {
										rows.set(packageId, {
											...existing,
											lastError: String(values[0]),
										})
									}
								}
								if (
									sql.includes('DELETE FROM saved_package_search_index_debt')
								) {
									const packageId = String(values[0])
									if (sql.includes('AND generation')) {
										const generation = Number(values[1])
										const existing = rows.get(packageId)
										if (existing?.generation === generation) {
											rows.delete(packageId)
										}
									} else {
										rows.delete(packageId)
									}
								}
								return { success: true }
							},
							async first() {
								if (sql.includes('SELECT generation FROM')) {
									const packageId = String(values[0])
									const existing = rows.get(packageId)
									return existing ? { generation: existing.generation } : null
								}
								if (sql.includes('SELECT package_id, user_id, generation')) {
									const packageId = String(values[0])
									const existing = rows.get(packageId)
									return existing
										? {
												package_id: existing.packageId,
												user_id: existing.userId,
												generation: existing.generation,
												embed_text: existing.embedText,
											}
										: null
								}
								return null
							},
							async all() {
								return { results: [...rows.values()] }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

function createScheduler() {
	const { db, rows } = createDebtDb()
	const waitUntilPromises: Array<Promise<unknown>> = []
	return {
		rows,
		waitUntilPromises,
		schedule(
			packageId: string,
			userId: string,
			embedText: string,
			options: { deferred?: boolean } = { deferred: true },
		) {
			return scheduleSavedPackageSearchIndexUpsert({
				env: { APP_DB: db } as Env,
				packageId,
				userId: ownerIdFromStored(userId),
				embedText,
				...(options.deferred
					? {
							waitUntil: (promise: Promise<unknown>) => {
								waitUntilPromises.push(promise)
							},
						}
					: {}),
			})
		},
	}
}

test('scheduleSavedPackageSearchIndexUpsert defers via waitUntil and clears debt on success', async () => {
	const upsertGate = Promise.withResolvers<void>()
	mockModule.upsertSavedPackageVector.mockImplementation(
		() => upsertGate.promise,
	)
	const scheduler = createScheduler()
	await scheduler.schedule('pkg-1', 'user-1', 'hello')
	expect(scheduler.rows.has('pkg-1')).toBe(true)
	expect(scheduler.waitUntilPromises).toHaveLength(1)
	await vi.waitFor(() => {
		expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledWith(
			expect.anything(),
			{
				packageId: 'pkg-1',
				userId: ownerIdFromStored('user-1'),
				embedText: 'hello',
			},
		)
	})
	upsertGate.resolve()
	await scheduler.waitUntilPromises[0]
	expect(scheduler.rows.has('pkg-1')).toBe(false)
})

test('scheduleSavedPackageSearchIndexUpsert keeps debt and reports to Sentry on failure', async () => {
	consoleError.mockImplementation(() => {})
	mockModule.upsertSavedPackageVector.mockRejectedValue(
		new Error('vectorize down'),
	)
	const scheduler = createScheduler()
	await scheduler.schedule('pkg-2', 'user-2', 'hello', { deferred: false })
	expect(scheduler.rows.get('pkg-2')).toMatchObject({
		packageId: 'pkg-2',
		userId: ownerIdFromStored('user-2'),
		generation: 1,
		lastError: 'vectorize down',
	})
	expect(mockModule.captureException).toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalled()
})

test('out-of-order publishes keep the newest owner and embed text under one coalesced reconcile', async () => {
	const firstUpsertGate = Promise.withResolvers<void>()
	mockModule.upsertSavedPackageVector
		.mockImplementationOnce(() => firstUpsertGate.promise)
		.mockResolvedValue(undefined)
	const scheduler = createScheduler()

	await scheduler.schedule('pkg-race', 'user-a', 'older')
	await scheduler.schedule('pkg-race', 'user-b', 'newer')
	expect(scheduler.rows.get('pkg-race')).toMatchObject({
		generation: 2,
		userId: ownerIdFromStored('user-b'),
		embedText: 'newer',
	})
	// Coalesced to one in-flight reconcile.
	await vi.waitFor(() => {
		expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(1)
	})
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({
			userId: ownerIdFromStored('user-a'),
			embedText: 'older',
		}),
	)

	firstUpsertGate.resolve()
	await Promise.all(scheduler.waitUntilPromises)

	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(2)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({
			userId: ownerIdFromStored('user-b'),
			embedText: 'newer',
		}),
	)
	expect(scheduler.rows.has('pkg-race')).toBe(false)
})
