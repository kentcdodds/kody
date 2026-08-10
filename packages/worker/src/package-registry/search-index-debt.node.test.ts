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

function createDebtDb() {
	const rows = new Map<
		string,
		{ packageId: string; userId: string; lastError: string | null }
	>()
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
									rows.set(packageId, {
										packageId,
										userId: String(values[1]),
										lastError: values[2] == null ? null : String(values[2]),
									})
								}
								if (
									sql.includes('DELETE FROM saved_package_search_index_debt')
								) {
									rows.delete(String(values[0]))
								}
								return { success: true }
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
	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledWith(
		expect.anything(),
		{
			packageId: 'pkg-1',
			userId: 'user-1',
			embedText: 'hello',
		},
	)
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
		lastError: 'vectorize down',
	})
	expect(mockModule.captureException).toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalled()
})

test('mark and clear debt helpers round-trip', async () => {
	const { db, rows } = createDebtDb()
	await markSavedPackageSearchIndexDebt({
		db,
		packageId: 'pkg-3',
		userId: 'user-3',
		lastError: 'pending',
	})
	expect(rows.get('pkg-3')?.lastError).toBe('pending')
	await clearSavedPackageSearchIndexDebt({ db, packageId: 'pkg-3' })
	expect(rows.has('pkg-3')).toBe(false)
})
