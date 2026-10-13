import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	packageFailureSummaryMaxPackageIds,
	type RunLogPackageFailureSummary,
	type RunLogPackageFailureSummaryInput,
} from '#worker/run-records/package-failure-summary.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	listPackageOwners,
	loadPackagePlacementFailures,
	packagePlacementFailuresMaxOwners,
} from './package-placement-failures.ts'

const runLogMocks = vi.hoisted(() => ({
	summarizePackageFailures:
		vi.fn<
			(input: {
				env: Env
				userId: string
				window: RunLogPackageFailureSummaryInput
			}) => Promise<RunLogPackageFailureSummary>
		>(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getAdminInsightsSnapshot: vi.fn(),
	summarizePackageFailures: (input: {
		env: Env
		userId: string
		window: RunLogPackageFailureSummaryInput
	}) => runLogMocks.summarizePackageFailures(input),
}))

const ownerA = ownerIdFromStored('owner-a')
const ownerB = ownerIdFromStored('owner-b')
const ownerC = ownerIdFromStored('owner-c')

function counts(count: number, firstAt: string | null, lastAt = firstAt) {
	return { count, firstAt, lastAt }
}

function createDb() {
	return {
		prepare(query: string) {
			const statement = {
				bind() {
					return statement
				},
				async all<T>() {
					if (query.includes('FROM package_codemod_run_items')) {
						return {
							results: [
								{
									id: 'item-1',
									run_id: 'scan-run',
									user_id: ownerB,
									package_id: 'pkg-flagged',
									kody_id: 'bluesky',
									status: 'needs_manual',
									findings_json: JSON.stringify([
										{
											path: 'src/index.ts',
											message:
												'secret outside header: puts a secret placeholder in a request URL, query, or body.',
										},
									]),
									changed_paths_json: '[]',
									created_at: '2026-10-11T00:00:00.000Z',
									updated_at: '2026-10-11T00:00:00.000Z',
								},
								{
									id: 'item-2',
									run_id: 'scan-run',
									user_id: ownerC,
									package_id: 'pkg-other-finding',
									kody_id: 'other',
									status: 'needs_manual',
									findings_json: JSON.stringify([
										{
											path: null,
											message: 'plain http: fetches an http:// URL.',
										},
									]),
									changed_paths_json: '[]',
									created_at: '2026-10-11T00:00:00.000Z',
									updated_at: '2026-10-11T00:00:00.000Z',
								},
							] as Array<T>,
						}
					}
					if (query.includes('SELECT DISTINCT user_id')) {
						return {
							results: [{ user_id: ownerA }, { user_id: ownerB }] as Array<T>,
						}
					}
					if (query.includes('FROM orgs')) {
						return {
							results: [
								{ id: ownerA, slug: 'alice' },
								{ id: ownerB, slug: 'bob' },
							] as Array<T>,
						}
					}
					if (query.includes('SELECT id, kody_id FROM saved_packages')) {
						return {
							results: [{ id: 'pkg-refused', kody_id: 'weather' }] as Array<T>,
						}
					}
					throw new Error(`Unsupported query: ${query}`)
				},
			}
			return statement
		},
	} as unknown as D1Database
}

test('loadPackagePlacementFailures joins refusal counts and flagged failures to owner handles', async () => {
	runLogMocks.summarizePackageFailures.mockImplementation(async (input) => {
		if (input.userId === ownerA) {
			expect(input.window.packageIds).toEqual([])
			return {
				packages: [
					{
						packageId: 'pkg-refused',
						placementRefusals: counts(
							3,
							'2026-10-11T03:00:00.000Z',
							'2026-10-11T09:00:00.000Z',
						),
						failedRuns: null,
					},
				],
			}
		}
		if (input.userId === ownerB) {
			expect(input.window).toEqual({
				since: '2026-10-11T02:51:00.000Z',
				until: '2026-10-11T15:49:00.000Z',
				packageIds: ['pkg-flagged'],
			})
			return {
				packages: [
					{
						packageId: 'pkg-flagged',
						placementRefusals: counts(0, null),
						failedRuns: counts(2, '2026-10-11T04:00:00.000Z'),
					},
				],
			}
		}
		throw new Error(`unexpected owner ${input.userId}`)
	})

	const report = await loadPackagePlacementFailures({
		env: { APP_DB: createDb() } as unknown as Env,
		window: {
			since: '2026-10-11T02:51:00.000Z',
			until: '2026-10-11T15:49:00.000Z',
			flaggedByCodemodRun: {
				runId: 'scan-run',
				finding: 'secret outside header',
			},
		},
	})

	expect(report).toEqual({
		since: '2026-10-11T02:51:00.000Z',
		until: '2026-10-11T15:49:00.000Z',
		flaggedPackageCount: 1,
		ownersAttempted: 2,
		ownersLoaded: 2,
		complete: true,
		packages: [
			{
				ownerId: ownerA,
				ownerHandle: 'alice',
				packageId: 'pkg-refused',
				kodyId: 'weather',
				flagged: false,
				placementRefusals: counts(
					3,
					'2026-10-11T03:00:00.000Z',
					'2026-10-11T09:00:00.000Z',
				),
				failedRuns: null,
			},
			{
				ownerId: ownerB,
				ownerHandle: 'bob',
				packageId: 'pkg-flagged',
				kodyId: 'bluesky',
				flagged: true,
				placementRefusals: counts(0, null),
				failedRuns: counts(2, '2026-10-11T04:00:00.000Z'),
			},
		],
	})
})

test('loadPackagePlacementFailures reports a flagged package with no failures and marks an unreadable owner incomplete', async () => {
	runLogMocks.summarizePackageFailures.mockImplementation(async (input) => {
		if (input.userId === ownerA) throw new Error('RunLog unavailable')
		return { packages: [] }
	})
	consoleWarn.mockImplementation(() => {})

	const report = await loadPackagePlacementFailures({
		env: { APP_DB: createDb() } as unknown as Env,
		window: {
			since: '2026-10-11T02:51:00.000Z',
			until: '2026-10-11T15:49:00.000Z',
			flaggedByCodemodRun: {
				runId: 'scan-run',
				finding: 'secret outside header',
			},
		},
	})

	expect(report.complete).toBe(false)
	expect(report.ownersLoaded).toBe(1)
	expect(report.packages).toEqual([
		{
			ownerId: ownerB,
			ownerHandle: 'bob',
			packageId: 'pkg-flagged',
			kodyId: 'bluesky',
			flagged: true,
			placementRefusals: counts(0, null),
			failedRuns: counts(0, null),
		},
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-placement-failures-owner-unavailable',
		expect.objectContaining({ ownerId: ownerA }),
	)
})

test('listPackageOwners marks truncated when flagged owners displace live owners', async () => {
	const liveOwners = Array.from({ length: 3 }, (_, index) =>
		ownerIdFromStored(`live-${index}`),
	)
	const flagged = Array.from(
		{ length: packagePlacementFailuresMaxOwners },
		(_, index) => ownerIdFromStored(`flag-${index}`),
	)
	const db = {
		prepare() {
			const statement = {
				bind() {
					return statement
				},
				async all() {
					return {
						results: liveOwners.map((user_id) => ({ user_id })),
					}
				},
			}
			return statement
		},
	} as unknown as D1Database

	const listed = await listPackageOwners(db, flagged)
	expect(listed.truncated).toBe(true)
	expect(listed.ownerIds).toHaveLength(packagePlacementFailuresMaxOwners)
	expect(listed.ownerIds.every((id) => id.startsWith('flag-'))).toBe(true)
})

test('loadPackagePlacementFailures truncates oversized flagged lists instead of aborting the report', async () => {
	const packageIds = Array.from(
		{ length: packageFailureSummaryMaxPackageIds + 1 },
		(_, index) => `pkg-overflow-${index}`,
	)
	const db = {
		prepare(query: string) {
			const statement = {
				bind() {
					return statement
				},
				async all<T>() {
					if (query.includes('FROM saved_packages') && query.includes('IN (')) {
						return {
							results: packageIds.map((id) => ({
								id,
								user_id: ownerA,
								kody_id: id.replace('pkg-', ''),
							})) as Array<T>,
						}
					}
					if (query.includes('SELECT DISTINCT user_id')) {
						return { results: [{ user_id: ownerA }] as Array<T> }
					}
					if (query.includes('FROM orgs')) {
						return {
							results: [{ id: ownerA, slug: 'alice' }] as Array<T>,
						}
					}
					throw new Error(`Unsupported query: ${query}`)
				},
			}
			return statement
		},
	} as unknown as D1Database

	runLogMocks.summarizePackageFailures.mockImplementation(async (input) => {
		expect(input.userId).toBe(ownerA)
		expect(input.window.packageIds).toHaveLength(
			packageFailureSummaryMaxPackageIds,
		)
		return {
			packages: (input.window.packageIds ?? []).map((packageId) => ({
				packageId,
				placementRefusals: counts(0, null),
				failedRuns: counts(0, null),
			})),
		}
	})

	const report = await loadPackagePlacementFailures({
		env: { APP_DB: db } as unknown as Env,
		window: {
			since: '2026-10-11T02:51:00.000Z',
			until: '2026-10-11T15:49:00.000Z',
			packageIds,
		},
	})

	expect(report.complete).toBe(false)
	expect(report.flaggedPackageCount).toBe(packageIds.length)
	expect(report.packages).toHaveLength(packageFailureSummaryMaxPackageIds)
	expect(report.packages.every((row) => row.ownerId === ownerA)).toBe(true)
})

test('loadPackagePlacementFailures rejects an inverted or oversized window before reading', async () => {
	const env = { APP_DB: createDb() } as unknown as Env
	await expect(
		loadPackagePlacementFailures({
			env,
			window: {
				since: '2026-10-11T15:49:00.000Z',
				until: '2026-10-11T02:51:00.000Z',
			},
		}),
	).rejects.toThrow('until must be after since.')
	await expect(
		loadPackagePlacementFailures({
			env,
			window: {
				since: '2026-08-01T00:00:00.000Z',
				until: '2026-10-11T00:00:00.000Z',
			},
		}),
	).rejects.toThrow('at most 31 days')
})
