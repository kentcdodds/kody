import { expect, test, vi } from 'vitest'
import { type RunLogAdminInsightsSnapshot } from '#worker/run-records/admin-insights-snapshot.ts'
import {
	adminInsightsRunLogConcurrency,
	adminInsightsRunLogMaxUsersPerTick,
	adminInsightsRunLogSnapshotKvKey,
	foldRunLogSnapshots,
	readAdminInsightsRunLogSnapshot,
	refreshAdminInsightsRunLogSnapshot,
} from './insights-runlog-snapshot.ts'

const runLogMocks = vi.hoisted(() => ({
	getAdminInsightsSnapshot:
		vi.fn<
			(input: {
				env: Env
				userId: string
			}) => Promise<RunLogAdminInsightsSnapshot>
		>(),
	inFlight: 0,
	maxInFlight: 0,
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getAdminInsightsSnapshot: (input: { env: Env; userId: string }) =>
		runLogMocks.getAdminInsightsSnapshot(input),
}))

function emptySnapshot(): RunLogAdminInsightsSnapshot {
	return {
		workflowStatusCounts: [],
		activationMilestones: [],
		jobRunCounts: { success: 0, error: 0 },
	}
}

function createMemoryKv() {
	const store = new Map<string, string>()
	return {
		store,
		async get<T>(key: string, type?: 'json' | 'text') {
			const raw = store.get(key)
			if (raw == null) return null
			return type === 'json' ? (JSON.parse(raw) as T) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace & { store: Map<string, string> }
}

function createUsersDb(
	users: Array<{ stable_user_id: string; email_verified_at: string | null }>,
) {
	return {
		prepare(query: string) {
			const statement = {
				bind() {
					return statement
				},
				async all<T>() {
					if (
						query.includes('stable_user_id') &&
						query.includes('deleting_at IS NULL')
					) {
						return { results: users as Array<T> }
					}
					throw new Error(`Unsupported query: ${query}`)
				},
			}
			return statement
		},
	} as unknown as D1Database
}

test('refreshAdminInsightsRunLogSnapshot writes a content-free KV snapshot and bounds concurrency', async () => {
	runLogMocks.inFlight = 0
	runLogMocks.maxInFlight = 0
	runLogMocks.getAdminInsightsSnapshot.mockImplementation(async (input) => {
		runLogMocks.inFlight += 1
		runLogMocks.maxInFlight = Math.max(
			runLogMocks.maxInFlight,
			runLogMocks.inFlight,
		)
		await Promise.resolve()
		runLogMocks.inFlight -= 1
		if (input.userId === 'user-a') {
			return {
				workflowStatusCounts: [{ status: 'complete', count: 2 }],
				jobRunCounts: { success: 3, error: 1 },
				activationMilestones: [
					{
						milestone: 'package_run_succeeded',
						reachedAt: '2026-09-10T12:00:00.000Z',
						packageId: 'opaque-pkg',
					},
				],
			}
		}
		return emptySnapshot()
	})
	const kv = createMemoryKv()
	const now = new Date('2026-09-10T18:00:00.000Z')
	const snapshot = await refreshAdminInsightsRunLogSnapshot({
		env: {
			APP_DB: createUsersDb([
				{
					stable_user_id: 'user-a',
					email_verified_at: '2026-09-01T00:00:00.000Z',
				},
				{
					stable_user_id: 'user-b',
					email_verified_at: '2026-09-02T00:00:00.000Z',
				},
			]),
			BUNDLE_ARTIFACTS_KV: kv,
		} as Env,
		now,
	})

	expect(snapshot.workflowRuns).toBe(2)
	expect(snapshot.jobSuccessRuns).toBe(3)
	expect(snapshot.packageRunSucceededUsers).toBe(1)
	expect(snapshot.complete).toBe(true)
	expect(snapshot.snapshotUpdatedAt).toBe(now.toISOString())
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(2)
	expect(runLogMocks.maxInFlight).toBeLessThanOrEqual(
		adminInsightsRunLogConcurrency,
	)
	expect(kv.store.get(adminInsightsRunLogSnapshotKvKey)).not.toContain(
		'opaque-pkg',
	)

	const read = await readAdminInsightsRunLogSnapshot(kv)
	expect(read.workflowRuns).toBe(2)
	expect(read.snapshotUpdatedAt).toBe(now.toISOString())
	expect(read.complete).toBe(true)
})

test('readAdminInsightsRunLogSnapshot degrades when KV is missing or empty', async () => {
	expect(await readAdminInsightsRunLogSnapshot(undefined)).toMatchObject({
		complete: false,
		snapshotUpdatedAt: null,
		workflowRuns: 0,
	})
	expect(await readAdminInsightsRunLogSnapshot(createMemoryKv())).toMatchObject(
		{
			complete: false,
			snapshotUpdatedAt: null,
		},
	)
})

test('refreshAdminInsightsRunLogSnapshot throws when BUNDLE_ARTIFACTS_KV is missing', async () => {
	await expect(
		refreshAdminInsightsRunLogSnapshot({
			env: {
				APP_DB: createUsersDb([
					{
						stable_user_id: 'user-a',
						email_verified_at: '2026-09-01T00:00:00.000Z',
					},
				]),
			} as Env,
			now: new Date('2026-09-10T18:00:00.000Z'),
		}),
	).rejects.toThrow(/BUNDLE_ARTIFACTS_KV is required/)
})

test('refreshAdminInsightsRunLogSnapshot throws when the KV write fails', async () => {
	runLogMocks.getAdminInsightsSnapshot.mockResolvedValue(emptySnapshot())
	const kv = createMemoryKv()
	kv.put = async () => {
		throw new Error('kv write failed')
	}
	await expect(
		refreshAdminInsightsRunLogSnapshot({
			env: {
				APP_DB: createUsersDb([
					{
						stable_user_id: 'user-a',
						email_verified_at: '2026-09-01T00:00:00.000Z',
					},
				]),
				BUNDLE_ARTIFACTS_KV: kv,
			} as Env,
			now: new Date('2026-09-10T18:00:00.000Z'),
		}),
	).rejects.toThrow(/kv write failed/)
})

test('refreshAdminInsightsRunLogSnapshot caps per-tick fanout and marks the snapshot incomplete', async () => {
	runLogMocks.getAdminInsightsSnapshot.mockReset()
	runLogMocks.getAdminInsightsSnapshot.mockResolvedValue(emptySnapshot())
	const kv = createMemoryKv()
	const users = Array.from(
		{ length: adminInsightsRunLogMaxUsersPerTick + 1 },
		(_, index) => ({
			stable_user_id: `user-${String(index + 1).padStart(4, '0')}`,
			email_verified_at: '2026-09-01T00:00:00.000Z',
		}),
	)
	const snapshot = await refreshAdminInsightsRunLogSnapshot({
		env: {
			APP_DB: createUsersDb(users),
			BUNDLE_ARTIFACTS_KV: kv,
		} as Env,
		now: new Date('2026-09-10T18:00:00.000Z'),
	})

	expect(snapshot.complete).toBe(false)
	expect(snapshot.usersAttempted).toBe(adminInsightsRunLogMaxUsersPerTick)
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(
		adminInsightsRunLogMaxUsersPerTick,
	)
	const stored = JSON.parse(
		kv.store.get(adminInsightsRunLogSnapshotKvKey) ?? '{}',
	) as { complete: boolean; usersAttempted: number }
	expect(stored.complete).toBe(false)
	expect(stored.usersAttempted).toBe(adminInsightsRunLogMaxUsersPerTick)
})

test('foldRunLogSnapshots still reports partial fanout without user content', () => {
	const folded = foldRunLogSnapshots([
		{
			user: {
				stable_user_id: 'u1',
				email_verified_at: '2026-07-01T00:00:00.000Z',
			},
			snapshot: emptySnapshot(),
		},
		{
			user: {
				stable_user_id: 'u2',
				email_verified_at: null,
			},
			snapshot: null,
		},
	])
	expect(folded).toMatchObject({
		usersAttempted: 2,
		usersLoaded: 1,
		complete: false,
	})
})
