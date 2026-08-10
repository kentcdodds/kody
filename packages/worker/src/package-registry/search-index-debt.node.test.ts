import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	upsertSavedPackageVector: vi.fn(),
	captureException: vi.fn(),
}))

vi.mock('./vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureException: (...args: Array<unknown>) =>
		mockModule.captureException(...args),
}))

import {
	clearSavedPackageSearchIndexDebt,
	markSavedPackageSearchIndexDebt,
	scheduleSavedPackageSearchIndexUpsert,
} from './search-index-debt.ts'

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

test('scheduleSavedPackageSearchIndexUpsert defers via waitUntil and clears debt on success', async () => {
	let resolveUpsert: (() => void) | undefined
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.upsertSavedPackageVector.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				resolveUpsert = resolve
			}),
	)
	const { db, rows } = createDebtDb()
	const waitUntilPromises: Array<Promise<unknown>> = []
	const schedulePromise = scheduleSavedPackageSearchIndexUpsert({
		env: { APP_DB: db } as Env,
		packageId: 'pkg-1',
		userId: 'user-1',
		embedText: 'hello',
		waitUntil: (promise) => {
			waitUntilPromises.push(promise)
		},
	})
	await schedulePromise
	expect(rows.has('pkg-1')).toBe(true)
	expect(waitUntilPromises).toHaveLength(1)
	await vi.waitFor(() => {
		expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledWith(
			expect.anything(),
			{
				packageId: 'pkg-1',
				userId: 'user-1',
				embedText: 'hello',
			},
		)
	})
	resolveUpsert?.()
	await waitUntilPromises[0]
	expect(rows.has('pkg-1')).toBe(false)
})

test('scheduleSavedPackageSearchIndexUpsert keeps debt and reports to Sentry on failure', async () => {
	consoleError.mockImplementation(() => {})
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.captureException.mockReset()
	mockModule.upsertSavedPackageVector.mockRejectedValue(
		new Error('vectorize down'),
	)
	const { db, rows } = createDebtDb()
	await scheduleSavedPackageSearchIndexUpsert({
		env: { APP_DB: db } as Env,
		packageId: 'pkg-2',
		userId: 'user-2',
		embedText: 'hello',
	})
	expect(rows.get('pkg-2')).toMatchObject({
		packageId: 'pkg-2',
		userId: 'user-2',
		generation: 1,
		lastError: 'vectorize down',
	})
	expect(mockModule.captureException).toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalled()
})

test('out-of-order publishes keep the newest embed text and debt generation', async () => {
	let resolveFirstUpsert: (() => void) | undefined
	let upsertCalls = 0
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.upsertSavedPackageVector.mockImplementation(async () => {
		upsertCalls += 1
		if (upsertCalls === 1) {
			await new Promise<void>((resolve) => {
				resolveFirstUpsert = resolve
			})
		}
	})
	const { db, rows } = createDebtDb()
	const waitUntilPromises: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		waitUntilPromises.push(promise)
	}

	await scheduleSavedPackageSearchIndexUpsert({
		env: { APP_DB: db } as Env,
		packageId: 'pkg-race',
		userId: 'user-1',
		embedText: 'older',
		waitUntil,
	})
	await scheduleSavedPackageSearchIndexUpsert({
		env: { APP_DB: db } as Env,
		packageId: 'pkg-race',
		userId: 'user-1',
		embedText: 'newer',
		waitUntil,
	})
	expect(rows.get('pkg-race')).toMatchObject({
		generation: 2,
		embedText: 'newer',
	})
	// Coalesced to one in-flight reconcile.
	await vi.waitFor(() => {
		expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(1)
	})
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({ embedText: 'older' }),
	)

	resolveFirstUpsert?.()
	await waitUntilPromises[0]
	await waitUntilPromises[1]

	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(2)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({ embedText: 'newer' }),
	)
	expect(rows.has('pkg-race')).toBe(false)
})

test('mark and clear debt helpers round-trip', async () => {
	const { db, rows } = createDebtDb()
	const generation = await markSavedPackageSearchIndexDebt({
		db,
		packageId: 'pkg-3',
		userId: 'user-3',
		embedText: 'pending text',
		lastError: 'pending',
	})
	expect(generation).toBe(1)
	expect(rows.get('pkg-3')?.lastError).toBe('pending')
	await clearSavedPackageSearchIndexDebt({
		db,
		packageId: 'pkg-3',
		generation,
	})
	expect(rows.has('pkg-3')).toBe(false)
})

test('reconcile upserts under the debt row owner, not the scheduler userId', async () => {
	let resolveFirstUpsert: (() => void) | undefined
	let upsertCalls = 0
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.upsertSavedPackageVector.mockImplementation(async () => {
		upsertCalls += 1
		if (upsertCalls === 1) {
			await new Promise<void>((resolve) => {
				resolveFirstUpsert = resolve
			})
		}
	})
	const { db, rows } = createDebtDb()
	const waitUntilPromises: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		waitUntilPromises.push(promise)
	}

	await scheduleSavedPackageSearchIndexUpsert({
		env: { APP_DB: db } as Env,
		packageId: 'pkg-owner',
		userId: 'user-a',
		embedText: 'from-a',
		waitUntil,
	})
	await scheduleSavedPackageSearchIndexUpsert({
		env: { APP_DB: db } as Env,
		packageId: 'pkg-owner',
		userId: 'user-b',
		embedText: 'from-b',
		waitUntil,
	})
	expect(rows.get('pkg-owner')).toMatchObject({
		userId: 'user-b',
		embedText: 'from-b',
		generation: 2,
	})

	resolveFirstUpsert?.()
	await waitUntilPromises[0]
	await waitUntilPromises[1]

	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledTimes(2)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({ userId: 'user-a', embedText: 'from-a' }),
	)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({ userId: 'user-b', embedText: 'from-b' }),
	)
})
