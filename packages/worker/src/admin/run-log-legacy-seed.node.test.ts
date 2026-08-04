import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import {
	adminRunLogLegacySeedActivationMaxMilestones,
	adminRunLogLegacySeedActivationMaxPackages,
	adminRunLogLegacySeedDefaultUserLimit,
	adminRunLogLegacySeedDefaultWorkflowImportPageSize,
	adminRunLogLegacySeedMaxUserLimit,
	runAdminRunLogLegacySeed,
	type AdminRunLogLegacySeedRpc,
} from './run-log-legacy-seed.ts'
import { activationMilestoneValues } from '#worker/run-records/package-activation-state.ts'
import {
	emptyLegacyParityBucketCounts,
	type LegacyParityVerifyResult,
	type LegacyParityWorkflowCheck,
} from '#worker/run-records/legacy-parity.ts'
import { workflowProjectionImportMaxBatch } from '#worker/run-records/workflow-projection.ts'

const userA = testStableUserIdFromEmail('runlog-a@example.com')
const userB = testStableUserIdFromEmail('runlog-b@example.com')
const userC = testStableUserIdFromEmail('runlog-c@example.com')
const deletingUser = testStableUserIdFromEmail('runlog-deleting@example.com')

const secretWorkflowName = 'secret-workflow-name-should-never-leak'
const secretJobError = 'secret-job-error-should-never-leak'
const secretPackageId = 'secret-package-id-should-never-leak'
const secretEmail = 'victim@example.com'

function createSweepDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			deleting_at TEXT
		);
		CREATE TABLE workflow_runs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_type TEXT NOT NULL,
			package_id TEXT,
			kody_id TEXT,
			source_id TEXT,
			workflow_name TEXT NOT NULL,
			export_name TEXT,
			idempotency_key TEXT NOT NULL,
			run_at TEXT NOT NULL,
			plan_date TEXT,
			status TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			last_error TEXT
		);
		CREATE TABLE jobs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			last_run_error TEXT,
			last_duration_ms INTEGER,
			run_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE user_package_run_successes (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			success_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id)
		);
		CREATE TABLE user_activation_milestones (
			user_id TEXT NOT NULL,
			milestone TEXT NOT NULL,
			reached_at TEXT NOT NULL,
			package_id TEXT,
			PRIMARY KEY (user_id, milestone)
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertUser(
	sqlite: DatabaseSync,
	input: {
		stableUserId: string
		email?: string
		deletingAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO users (stable_user_id, username, email, deleting_at)
			VALUES (?, ?, ?, ?)`,
		)
		.run(
			input.stableUserId,
			'user',
			input.email ?? secretEmail,
			input.deletingAt ?? null,
		)
}

function insertWorkflow(
	sqlite: DatabaseSync,
	input: {
		userId: string
		id: string
		name?: string
		updatedAt?: string
	},
) {
	const updatedAt = input.updatedAt ?? '2026-07-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO workflow_runs (
				id, user_id, source_type, workflow_name, idempotency_key,
				run_at, created_at, updated_at, status
			) VALUES (?, ?, 'inline', ?, ?, ?, ?, ?, 'complete')`,
		)
		.run(
			input.id,
			input.userId,
			input.name ?? secretWorkflowName,
			`key-${input.id}`,
			updatedAt,
			updatedAt,
			updatedAt,
		)
}

function insertJob(
	sqlite: DatabaseSync,
	input: { userId: string; id: string; error?: string },
) {
	sqlite
		.prepare(
			`INSERT INTO jobs (
				id, user_id, last_run_at, last_run_status, last_run_error,
				last_duration_ms, run_count, success_count, error_count, updated_at
			) VALUES (?, ?, ?, 'error', ?, 9, 2, 1, 1, ?)`,
		)
		.run(
			input.id,
			input.userId,
			'2026-07-01T00:00:00.000Z',
			input.error ?? secretJobError,
			'2026-07-01T00:00:00.000Z',
		)
}

function insertActivation(
	sqlite: DatabaseSync,
	input: { userId: string; packageId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO user_package_run_successes (
				user_id, package_id, success_count, updated_at
			) VALUES (?, ?, 2, ?)`,
		)
		.run(input.userId, input.packageId, '2026-07-01T00:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO user_activation_milestones (
				user_id, milestone, reached_at, package_id
			) VALUES (?, 'package_run_succeeded', ?, ?)`,
		)
		.run(input.userId, '2026-07-01T00:00:00.000Z', input.packageId)
}

function emptyParity(overrides?: Partial<LegacyParityVerifyResult>) {
	return {
		workflows: emptyLegacyParityBucketCounts(),
		jobs: emptyLegacyParityBucketCounts(),
		activationPackages: emptyLegacyParityBucketCounts(),
		activationMilestones: emptyLegacyParityBucketCounts(),
		activationInitialized: false,
		parity: true,
		...overrides,
	} satisfies LegacyParityVerifyResult
}

function createTrackingRpc(input?: {
	failUserIds?: ReadonlySet<string>
	initializedByDefault?: boolean
}) {
	const failUserIds = input?.failUserIds ?? new Set<string>()
	const initializedUsers = new Set<string>()
	const seededJobIdsByUser = new Map<string, Set<string>>()
	const importedWorkflowsByUser = new Map<
		string,
		Map<string, string /* updatedAt */>
	>()
	const callOrder: Array<string> = []
	const calls = {
		importWorkflowProjections: [] as Array<{
			userId: string
			count: number
			ids: Array<string>
			updatedAts: Array<string>
		}>,
		seedJobRunObservabilityBatch: [] as Array<{
			userId: string
			count: number
			ids: Array<string>
			seeded: number
			alreadySeeded: number
		}>,
		importActivationState: [] as Array<{
			userId: string
			packageCount: number
			milestoneCount: number
		}>,
		verifyLegacyParity: [] as Array<{
			userId: string
			workflowCount: number
			jobCount: number
			packageCount: number
			milestoneCount: number
			workflowIds: Array<string>
			workflowMinimumUpdatedAts: Array<string | null>
			jobIds: Array<string>
			packageIds: Array<string>
		}>,
	}

	const rpc: AdminRunLogLegacySeedRpc = {
		async importWorkflowProjections({ userId, projections }) {
			if (failUserIds.has(userId)) {
				throw new Error(`injected-workflow-import-failure:${userId}`)
			}
			callOrder.push('importWorkflowProjections')
			const ids = projections.map((row) => row.id)
			const updatedAts = projections.map((row) => row.updatedAt ?? '')
			calls.importWorkflowProjections.push({
				userId,
				count: projections.length,
				ids,
				updatedAts,
			})
			const set =
				importedWorkflowsByUser.get(userId) ?? new Map<string, string>()
			for (const projection of projections) {
				set.set(projection.id, projection.updatedAt ?? '')
			}
			importedWorkflowsByUser.set(userId, set)
			return { imported: projections.length }
		},
		async seedJobRunObservabilityBatch({ userId, seeds }) {
			if (failUserIds.has(userId)) {
				throw new Error(`injected-job-seed-failure:${userId}`)
			}
			callOrder.push('seedJobRunObservabilityBatch')
			const ids = seeds.map((row) => row.jobId)
			const set = seededJobIdsByUser.get(userId) ?? new Set<string>()
			let seeded = 0
			let alreadySeeded = 0
			for (const id of ids) {
				if (set.has(id)) {
					alreadySeeded += 1
				} else {
					set.add(id)
					seeded += 1
				}
			}
			seededJobIdsByUser.set(userId, set)
			calls.seedJobRunObservabilityBatch.push({
				userId,
				count: seeds.length,
				ids,
				seeded,
				alreadySeeded,
			})
			return { attempted: seeds.length, seeded, alreadySeeded }
		},
		async importActivationState({ userId, state }) {
			if (failUserIds.has(userId)) {
				throw new Error(`injected-activation-import-failure:${userId}`)
			}
			callOrder.push('importActivationState')
			calls.importActivationState.push({
				userId,
				packageCount: state.packageRunSuccesses.length,
				milestoneCount: state.milestones.length,
			})
			initializedUsers.add(userId)
			return { initialized: true }
		},
		async verifyLegacyParity(args) {
			const userId = args.userId
			if (failUserIds.has(userId)) {
				throw new Error(`injected-verify-failure:${userId}`)
			}
			callOrder.push('verifyLegacyParity')
			const workflowChecks: Array<LegacyParityWorkflowCheck> = (
				args.workflows ?? []
			).map((entry) =>
				typeof entry === 'string'
					? { id: entry }
					: {
							id: entry.id,
							minimumUpdatedAt: entry.minimumUpdatedAt ?? null,
						},
			)
			const jobIds = args.jobIds ?? []
			const packages = args.activationPackages ?? []
			const milestones = args.activationMilestones ?? []
			calls.verifyLegacyParity.push({
				userId,
				workflowCount: workflowChecks.length,
				jobCount: jobIds.length,
				packageCount: packages.length,
				milestoneCount: milestones.length,
				workflowIds: workflowChecks.map((check) => check.id),
				workflowMinimumUpdatedAts: workflowChecks.map(
					(check) => check.minimumUpdatedAt ?? null,
				),
				jobIds,
				packageIds: packages.map((row) => row.packageId),
			})

			const imported = importedWorkflowsByUser.get(userId) ?? new Map()
			const seeded = seededJobIdsByUser.get(userId) ?? new Set()
			const initialized =
				initializedUsers.has(userId) || Boolean(input?.initializedByDefault)

			const workflows = emptyLegacyParityBucketCounts()
			for (const check of workflowChecks) {
				const storedUpdatedAt = imported.get(check.id)
				if (storedUpdatedAt == null && !input?.initializedByDefault) {
					workflows.missing += 1
					continue
				}
				const doUpdatedAt =
					storedUpdatedAt ??
					check.minimumUpdatedAt ??
					'1970-01-01T00:00:00.000Z'
				const minimumUpdatedAt = check.minimumUpdatedAt?.trim() || null
				if (minimumUpdatedAt && doUpdatedAt < minimumUpdatedAt) {
					workflows.underCount += 1
					continue
				}
				workflows.matched += 1
			}
			const jobs = emptyLegacyParityBucketCounts()
			for (const id of jobIds) {
				if (seeded.has(id) || input?.initializedByDefault) {
					jobs.matched += 1
				} else {
					jobs.missing += 1
				}
			}
			const activationPackages = emptyLegacyParityBucketCounts()
			for (const _row of packages) {
				if (initialized) activationPackages.matched += 1
				else activationPackages.missing += 1
			}
			const activationMilestones = emptyLegacyParityBucketCounts()
			for (const _milestone of milestones) {
				if (initialized) activationMilestones.matched += 1
				else activationMilestones.missing += 1
			}

			const parity =
				workflows.missing === 0 &&
				workflows.underCount === 0 &&
				jobs.missing === 0 &&
				jobs.underCount === 0 &&
				activationPackages.missing === 0 &&
				activationPackages.underCount === 0 &&
				activationMilestones.missing === 0 &&
				activationMilestones.underCount === 0

			return emptyParity({
				workflows,
				jobs,
				activationPackages,
				activationMilestones,
				activationInitialized: initialized,
				parity,
			})
		},
	}

	return { rpc, calls, callOrder, initializedUsers, importedWorkflowsByUser }
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		RUN_LOG: {} as DurableObjectNamespace,
	}
}

function assertContentFree(value: unknown) {
	const serialized = JSON.stringify(value)
	const denied = [
		secretWorkflowName,
		secretJobError,
		secretPackageId,
		secretEmail,
		'workflowName',
		'lastRunError',
		'packageId',
		'jobId',
		'last_error',
		'minimumUpdatedAt',
		'injected-workflow-import-failure',
		'injected-job-seed-failure',
		'injected-activation-import-failure',
		'injected-verify-failure',
		'activation package inventory exceeds',
		'activation milestone inventory exceeds',
	]
	for (const token of denied) {
		expect(serialized).not.toContain(token)
	}
}

test('status pages all non-deleting users including empty legacy inventory', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertUser(sqlite, { stableUserId: userB })
	insertUser(sqlite, { stableUserId: userC })
	insertUser(sqlite, {
		stableUserId: deletingUser,
		deletingAt: '2026-08-01T00:00:00.000Z',
	})
	insertWorkflow(sqlite, { userId: userA, id: 'wf-a-1' })
	insertJob(sqlite, { userId: userA, id: 'job-a-1' })

	const { rpc, calls } = createTrackingRpc()
	const ordered = [userA, userB, userC].sort()
	const firstPage = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 2,
		rpc,
		now: new Date('2026-08-03T12:00:00.000Z'),
	})
	expect(firstPage.action).toBe('status')
	expect(firstPage.generatedAt).toBe('2026-08-03T12:00:00.000Z')
	expect(firstPage.truncated).toBe(true)
	expect(firstPage.usersAttempted).toBe(2)
	expect(firstPage.users).toHaveLength(2)
	expect(firstPage.users.map((user) => user.stableUserId)).toEqual(
		ordered.slice(0, 2),
	)
	expect(firstPage.nextStartAfter).toBe(ordered[1])
	expect(firstPage.users.every((user) => user.parity === false)).toBe(true)

	const secondPage = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 2,
		startAfterUserId: firstPage.nextStartAfter,
		rpc,
	})
	expect(secondPage.truncated).toBe(false)
	expect(secondPage.nextStartAfter).toBeNull()
	expect(secondPage.users.map((user) => user.stableUserId)).toEqual([
		ordered[2],
	])
	expect(calls.verifyLegacyParity.map((call) => call.userId).sort()).toEqual(
		expect.arrayContaining(ordered),
	)
	expect(
		calls.verifyLegacyParity.some((call) => call.userId === deletingUser),
	).toBe(false)
	assertContentFree(firstPage)
	assertContentFree(secondPage)
})

test('exact full-last-page truncation is false with limit+1 fetch', async () => {
	const { sqlite, db } = createSweepDb()
	const ids = [userA, userB, userC, deletingUser]
		.filter((id) => id !== deletingUser)
		.sort()
	// Exactly 4 active users; page size 2 → page2 is a full page with nothing after.
	for (const id of ids) insertUser(sqlite, { stableUserId: id })
	insertUser(sqlite, {
		stableUserId: deletingUser,
		deletingAt: '2026-08-01T00:00:00.000Z',
	})
	const fourth = testStableUserIdFromEmail('runlog-d@example.com')
	insertUser(sqlite, { stableUserId: fourth })
	const ordered = [...ids, fourth].sort()
	expect(ordered).toHaveLength(4)

	const { rpc } = createTrackingRpc()
	const page1 = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 2,
		rpc,
	})
	expect(page1.truncated).toBe(true)
	expect(page1.users).toHaveLength(2)
	expect(page1.nextStartAfter).toBe(ordered[1])

	const page2 = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 2,
		startAfterUserId: page1.nextStartAfter,
		rpc,
	})
	// Full last page of exactly `limit` users must not claim truncation.
	expect(page2.users).toHaveLength(2)
	expect(page2.users.map((user) => user.stableUserId)).toEqual(ordered.slice(2))
	expect(page2.truncated).toBe(false)
	expect(page2.nextStartAfter).toBeNull()
	assertContentFree(page2)
})

test('seed marks empty-user activation unconditional-done and reaches parity', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	const { rpc, calls } = createTrackingRpc()

	const statusBefore = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 1,
		rpc,
	})
	expect(statusBefore.users).toEqual([
		expect.objectContaining({
			stableUserId: userA,
			failed: false,
			parity: false,
			activationInitialized: false,
		}),
	])

	const seeded = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(seeded.users).toEqual([
		{
			stableUserId: userA,
			failed: false,
			parity: true,
			activationInitialized: true,
			workflows: emptyLegacyParityBucketCounts(),
			jobs: emptyLegacyParityBucketCounts(),
			activationPackages: emptyLegacyParityBucketCounts(),
			activationMilestones: emptyLegacyParityBucketCounts(),
		},
	])
	expect(seeded.usersAtParity).toBe(1)
	expect(calls.importActivationState).toEqual([
		{ userId: userA, packageCount: 0, milestoneCount: 0 },
	])
	assertContentFree(seeded)
})

test('multi-batch workflows/jobs process pages incrementally without all-row accumulation', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	for (let index = 0; index < 5; index += 1) {
		insertWorkflow(sqlite, {
			userId: userA,
			id: `wf-${String(index).padStart(3, '0')}`,
		})
		insertJob(sqlite, {
			userId: userA,
			id: `job-${String(index).padStart(3, '0')}`,
		})
	}
	insertActivation(sqlite, { userId: userA, packageId: secretPackageId })

	const { rpc, calls, callOrder } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
		batchSizes: {
			workflowImport: 2,
			jobSeed: 2,
			verify: 2,
		},
	})

	expect(result.users[0]?.parity).toBe(true)
	expect(calls.importWorkflowProjections.map((call) => call.count)).toEqual([
		2, 2, 1,
	])
	expect(calls.seedJobRunObservabilityBatch.map((call) => call.count)).toEqual([
		2, 2, 1,
	])
	// Each workflow import page is verified before the next page is fetched.
	const workflowPhase = callOrder.slice(
		0,
		callOrder.indexOf('seedJobRunObservabilityBatch'),
	)
	expect(workflowPhase).toEqual([
		'importWorkflowProjections',
		'verifyLegacyParity',
		'importWorkflowProjections',
		'verifyLegacyParity',
		'importWorkflowProjections',
		'verifyLegacyParity',
	])
	expect(
		calls.verifyLegacyParity.every(
			(call) =>
				call.workflowCount <= 2 &&
				call.jobCount <= 2 &&
				call.packageCount <= 2 &&
				call.milestoneCount <= 2,
		),
	).toBe(true)
	// Workflow verify always carries minimumUpdatedAt (not bare ids).
	const workflowVerifies = calls.verifyLegacyParity.filter(
		(call) => call.workflowCount > 0,
	)
	expect(workflowVerifies.length).toBeGreaterThan(0)
	for (const call of workflowVerifies) {
		expect(call.workflowMinimumUpdatedAts).toHaveLength(call.workflowCount)
		expect(
			call.workflowMinimumUpdatedAts.every(
				(value) => typeof value === 'string' && value.length > 0,
			),
		).toBe(true)
	}
	assertContentFree(result)
})

test('default workflow import page size paginates large inventories without all-row accumulation', async () => {
	expect(adminRunLogLegacySeedDefaultWorkflowImportPageSize).toBe(250)
	expect(adminRunLogLegacySeedDefaultWorkflowImportPageSize).toBeLessThan(
		workflowProjectionImportMaxBatch,
	)

	const workflowCount = 501
	const pageSize = adminRunLogLegacySeedDefaultWorkflowImportPageSize
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	for (let index = 0; index < workflowCount; index += 1) {
		insertWorkflow(sqlite, {
			userId: userA,
			id: `wf-${String(index).padStart(4, '0')}`,
		})
	}

	const { rpc, calls, callOrder } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})

	expect(result.users[0]?.parity).toBe(true)
	expect(result.users[0]?.workflows.matched).toBe(workflowCount)
	expect(calls.importWorkflowProjections.length).toBeGreaterThan(1)
	expect(calls.importWorkflowProjections.map((call) => call.count)).toEqual([
		pageSize,
		pageSize,
		workflowCount - pageSize * 2,
	])
	expect(
		calls.importWorkflowProjections.every((call) => call.count <= pageSize),
	).toBe(true)
	const workflowPhase = callOrder.slice(
		0,
		callOrder.indexOf('importActivationState'),
	)
	expect(workflowPhase.length).toBe(calls.importWorkflowProjections.length * 2)
	for (
		let index = 0;
		index < calls.importWorkflowProjections.length;
		index += 1
	) {
		expect(workflowPhase[index * 2]).toBe('importWorkflowProjections')
		expect(workflowPhase[index * 2 + 1]).toBe('verifyLegacyParity')
	}
	expect(
		calls.verifyLegacyParity
			.filter((call) => call.workflowCount > 0)
			.every((call) => call.workflowCount <= pageSize),
	).toBe(true)
	assertContentFree(result)
})

test('newer D1 workflow updatedAt surfaces underCount on status after stale seed', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertWorkflow(sqlite, {
		userId: userA,
		id: 'wf-stale',
		updatedAt: '2026-07-01T00:00:00.000Z',
	})
	const { rpc, calls, importedWorkflowsByUser } = createTrackingRpc()

	const seeded = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(seeded.users[0]?.parity).toBe(true)
	expect(importedWorkflowsByUser.get(userA)?.get('wf-stale')).toBe(
		'2026-07-01T00:00:00.000Z',
	)

	sqlite
		.prepare(`UPDATE workflow_runs SET updated_at = ? WHERE id = ?`)
		.run('2026-08-01T12:00:00.000Z', 'wf-stale')

	const status = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 1,
		rpc,
	})
	expect(status.users[0]).toMatchObject({
		stableUserId: userA,
		failed: false,
		parity: false,
		workflows: { matched: 0, missing: 0, underCount: 1 },
	})
	const statusWorkflowVerify = calls.verifyLegacyParity.find(
		(call) =>
			call.workflowIds.includes('wf-stale') &&
			call.workflowMinimumUpdatedAts.includes('2026-08-01T12:00:00.000Z'),
	)
	expect(statusWorkflowVerify).toBeTruthy()
	assertContentFree(status)
})

test('production activation package cap equals max plan saved packages', () => {
	expect(adminRunLogLegacySeedActivationMaxPackages).toBe(
		planLimits.max.maxSavedPackages,
	)
	expect(adminRunLogLegacySeedActivationMaxPackages).toBe(10_000)
})

test('activation package inventory respects injectable max with +1 fail-closed', async () => {
	const packageCap = 3
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	const insert = sqlite.prepare(
		`INSERT INTO user_package_run_successes (
			user_id, package_id, success_count, updated_at
		) VALUES (?, ?, 1, ?)`,
	)
	const updatedAt = '2026-07-01T00:00:00.000Z'
	for (let index = 0; index < packageCap; index += 1) {
		insert.run(userA, `pkg-${index}`, updatedAt)
	}

	const { rpc, calls } = createTrackingRpc()
	const atCap = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
		batchSizes: { activationMaxPackages: packageCap },
	})
	expect(atCap.users[0]?.parity).toBe(true)
	expect(calls.importActivationState).toEqual([
		{
			userId: userA,
			packageCount: packageCap,
			milestoneCount: 0,
		},
	])
	assertContentFree(atCap)

	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	insert.run(userA, `pkg-${packageCap}`, updatedAt)
	const overflow = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
		batchSizes: { activationMaxPackages: packageCap },
	})
	expect(overflow.users).toEqual([
		expect.objectContaining({
			stableUserId: userA,
			failed: true,
			parity: false,
			activationInitialized: false,
		}),
	])
	expect(calls.importActivationState).toHaveLength(1)
	assertContentFree(overflow)
})

test('activation milestones filter unknown rows and keep intrinsic known-name bound', async () => {
	expect(adminRunLogLegacySeedActivationMaxMilestones).toBe(
		activationMilestoneValues.length,
	)
	expect(adminRunLogLegacySeedActivationMaxMilestones).toBe(2)

	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	for (const milestone of activationMilestoneValues) {
		sqlite
			.prepare(
				`INSERT INTO user_activation_milestones (
					user_id, milestone, reached_at, package_id
				) VALUES (?, ?, ?, NULL)`,
			)
			.run(userA, milestone, '2026-07-01T00:00:00.000Z')
	}
	// Unknown/retired row must not consume the known-milestone cap.
	sqlite
		.prepare(
			`INSERT INTO user_activation_milestones (
				user_id, milestone, reached_at, package_id
			) VALUES (?, 'bogus_extra_milestone', ?, NULL)`,
		)
		.run(userA, '2026-07-01T00:00:00.000Z')

	const { rpc, calls } = createTrackingRpc()
	const seeded = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(seeded.users[0]?.parity).toBe(true)
	expect(calls.importActivationState).toEqual([
		{
			userId: userA,
			packageCount: 0,
			milestoneCount: adminRunLogLegacySeedActivationMaxMilestones,
		},
	])
	assertContentFree(seeded)
})

test('cross-user isolation: each user only verifies its own inventory ids', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertUser(sqlite, { stableUserId: userB })
	insertWorkflow(sqlite, { userId: userA, id: 'wf-only-a' })
	insertWorkflow(sqlite, { userId: userB, id: 'wf-only-b' })
	insertJob(sqlite, { userId: userA, id: 'job-only-a' })
	insertJob(sqlite, { userId: userB, id: 'job-only-b' })
	insertActivation(sqlite, { userId: userA, packageId: 'pkg-only-a' })
	insertActivation(sqlite, { userId: userB, packageId: 'pkg-only-b' })

	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 20,
		rpc,
	})
	expect(result.usersAttempted).toBe(2)
	expect(result.usersAtParity).toBe(2)

	const verifyA = calls.verifyLegacyParity.filter(
		(call) => call.userId === userA,
	)
	const verifyB = calls.verifyLegacyParity.filter(
		(call) => call.userId === userB,
	)
	expect(verifyA.flatMap((call) => call.workflowIds)).toEqual(['wf-only-a'])
	expect(verifyA.flatMap((call) => call.jobIds)).toEqual(['job-only-a'])
	expect(verifyA.flatMap((call) => call.packageIds)).toEqual(['pkg-only-a'])
	expect(verifyB.flatMap((call) => call.workflowIds)).toEqual(['wf-only-b'])
	expect(verifyB.flatMap((call) => call.jobIds)).toEqual(['job-only-b'])
	expect(verifyB.flatMap((call) => call.packageIds)).toEqual(['pkg-only-b'])
	assertContentFree(result)
})

test('idempotent reseed keeps parity and reports alreadySeeded on job path', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertJob(sqlite, { userId: userA, id: 'job-idem' })
	const { rpc, calls } = createTrackingRpc()

	const first = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	const second = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(first.users[0]?.parity).toBe(true)
	expect(second.users[0]?.parity).toBe(true)
	expect(calls.seedJobRunObservabilityBatch).toEqual([
		{
			userId: userA,
			count: 1,
			ids: ['job-idem'],
			seeded: 1,
			alreadySeeded: 0,
		},
		{
			userId: userA,
			count: 1,
			ids: ['job-idem'],
			seeded: 0,
			alreadySeeded: 1,
		},
	])
	expect(calls.importActivationState).toHaveLength(2)
	assertContentFree(first)
	assertContentFree(second)
})

test('partial failure continues other users and fails closed for the failing user', async () => {
	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertUser(sqlite, { stableUserId: userB })
	insertWorkflow(sqlite, { userId: userA, id: 'wf-a' })
	insertWorkflow(sqlite, { userId: userB, id: 'wf-b' })

	const ordered = [userA, userB].sort()
	const failUserIds = new Set([ordered[0]!])
	const { rpc } = createTrackingRpc({ failUserIds })
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 20,
		rpc,
	})

	expect(result.usersAttempted).toBe(2)
	expect(result.usersAtParity).toBe(1)
	const failed = result.users.find((user) => user.stableUserId === ordered[0])
	const ok = result.users.find((user) => user.stableUserId === ordered[1])
	expect(failed).toMatchObject({
		failed: true,
		parity: false,
		activationInitialized: false,
	})
	expect(ok).toMatchObject({ failed: false, parity: true })
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-run-log-legacy-seed-user-failed',
		expect.objectContaining({ stableUserId: ordered[0] }),
	)
	assertContentFree(result)
})

test('default and max user limits are bounded for activation snapshot cost', async () => {
	expect(adminRunLogLegacySeedDefaultUserLimit).toBe(1)
	expect(adminRunLogLegacySeedMaxUserLimit).toBe(5)
	expect(adminRunLogLegacySeedDefaultUserLimit).toBeLessThan(
		adminRunLogLegacySeedMaxUserLimit,
	)

	const { sqlite, db } = createSweepDb()
	const ids = Array.from(
		{ length: adminRunLogLegacySeedMaxUserLimit + 5 },
		(_, index) => testStableUserIdFromEmail(`limit-${index}@example.com`),
	).sort()
	for (const id of ids) insertUser(sqlite, { stableUserId: id })
	const { rpc } = createTrackingRpc()

	const defaults = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		rpc,
	})
	expect(defaults.usersAttempted).toBe(adminRunLogLegacySeedDefaultUserLimit)
	expect(defaults.users).toHaveLength(adminRunLogLegacySeedDefaultUserLimit)
	expect(defaults.truncated).toBe(true)

	const clamped = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 999,
		rpc,
	})
	expect(clamped.usersAttempted).toBe(adminRunLogLegacySeedMaxUserLimit)
	expect(clamped.users).toHaveLength(adminRunLogLegacySeedMaxUserLimit)
	expect(clamped.truncated).toBe(true)
})

test('status does not mutate RunLog via import/seed RPCs', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertWorkflow(sqlite, { userId: userA, id: 'wf-status' })
	const { rpc, calls } = createTrackingRpc()
	await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'status',
		limit: 1,
		rpc,
	})
	expect(calls.importWorkflowProjections).toEqual([])
	expect(calls.seedJobRunObservabilityBatch).toEqual([])
	expect(calls.importActivationState).toEqual([])
	expect(calls.verifyLegacyParity.length).toBeGreaterThan(0)
})

test('seed continues to import empty activation for users with only jobs/workflows', async () => {
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertJob(sqlite, { userId: userA, id: 'job-zero-ok' })
	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(result.users[0]).toMatchObject({
		failed: false,
		parity: true,
	})
	expect(calls.importActivationState).toEqual([
		{ userId: userA, packageCount: 0, milestoneCount: 0 },
	])
	expect(calls.seedJobRunObservabilityBatch[0]?.ids).toEqual(['job-zero-ok'])
	assertContentFree(result)
})

test('missing workflow_runs relation fails user closed without empty activation seed', async () => {
	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	sqlite.exec('DROP TABLE workflow_runs')
	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(result.users).toEqual([
		{
			stableUserId: userA,
			failed: true,
			parity: false,
			activationInitialized: false,
			workflows: emptyLegacyParityBucketCounts(),
			jobs: emptyLegacyParityBucketCounts(),
			activationPackages: emptyLegacyParityBucketCounts(),
			activationMilestones: emptyLegacyParityBucketCounts(),
		},
	])
	expect(calls.importActivationState).toEqual([])
	expect(calls.importWorkflowProjections).toEqual([])
	assertContentFree(result)
})

test('missing jobs relation fails user closed without empty activation seed', async () => {
	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	sqlite.exec('DROP TABLE jobs')
	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(result.users[0]).toMatchObject({
		stableUserId: userA,
		failed: true,
		parity: false,
		activationInitialized: false,
	})
	expect(calls.importActivationState).toEqual([])
	expect(calls.seedJobRunObservabilityBatch).toEqual([])
	assertContentFree(result)
})

test('missing activation package table fails user closed without marking initialized', async () => {
	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	sqlite.exec('DROP TABLE user_package_run_successes')
	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(result.users[0]).toMatchObject({
		stableUserId: userA,
		failed: true,
		parity: false,
		activationInitialized: false,
	})
	expect(calls.importActivationState).toEqual([])
	assertContentFree(result)
})

test('missing activation milestones table fails user closed without marking initialized', async () => {
	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	sqlite.exec('DROP TABLE user_activation_milestones')
	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(result.users[0]).toMatchObject({
		stableUserId: userA,
		failed: true,
		parity: false,
		activationInitialized: false,
	})
	expect(calls.importActivationState).toEqual([])
	assertContentFree(result)
})

test('partial activation query failure after package rows load fails closed', async () => {
	silenceExpectedConsoleWarns(['admin-run-log-legacy-seed-user-failed'])
	const { sqlite, db } = createSweepDb()
	insertUser(sqlite, { stableUserId: userA })
	insertActivation(sqlite, { userId: userA, packageId: secretPackageId })
	// Packages load successfully; milestone source then disappears mid-snapshot.
	sqlite.exec('DROP TABLE user_activation_milestones')
	const { rpc, calls } = createTrackingRpc()
	const result = await runAdminRunLogLegacySeed({
		env: createEnv(db),
		action: 'seed',
		limit: 1,
		rpc,
	})
	expect(result.users[0]).toMatchObject({
		stableUserId: userA,
		failed: true,
		parity: false,
		activationInitialized: false,
	})
	// Must not import a partial activation snapshot as unconditional-done.
	expect(calls.importActivationState).toEqual([])
	assertContentFree(result)
})
