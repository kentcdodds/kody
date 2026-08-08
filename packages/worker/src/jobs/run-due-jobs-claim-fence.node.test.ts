import { expect, test, vi } from 'vitest'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { type JobRecord } from './types.ts'
import { TransientJobExecutionError } from './execution-safety.ts'

const withAccountWriteLease = vi.fn(
	async (input: { write: () => Promise<unknown> }) => input.write(),
)
const disableExpiredJobRowsForUser = vi.fn(async () => 0)
const listDueJobRows = vi.fn()
const claimJobRow = vi.fn()
const finalizeClaimedJobRow = vi.fn()
const retryClaimedJobRow = vi.fn()
const claimRunRecord = vi.fn()
const listArchivedJobArtifactsDueBefore = vi.fn(async () => [])
const getEntitySourceByIdForUser = vi.fn()
const getSavedPackageById = vi.fn()

vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: (...args: Array<unknown>) =>
		withAccountWriteLease(...(args as [never])),
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./repo.ts')>()
	return {
		...actual,
		disableExpiredJobRowsForUser: (...args: Array<unknown>) =>
			disableExpiredJobRowsForUser(...(args as [never])),
		listDueJobRows: (...args: Array<unknown>) =>
			listDueJobRows(...(args as [never])),
		claimJobRow: (...args: Array<unknown>) => claimJobRow(...(args as [never])),
		finalizeClaimedJobRow: (...args: Array<unknown>) =>
			finalizeClaimedJobRow(...(args as [never])),
		retryClaimedJobRow: (...args: Array<unknown>) =>
			retryClaimedJobRow(...(args as [never])),
	}
})

vi.mock('#worker/run-records/service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/run-records/service.ts')>()
	return {
		...actual,
		claimRunRecord: (...args: Array<unknown>) =>
			claimRunRecord(...(args as [never])),
		abandonRunRecord: vi.fn(),
		finishRunRecord: vi.fn(),
		getRunRecord: vi.fn(),
	}
})

vi.mock('#worker/repo/entity-sources.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/repo/entity-sources.ts')>()
	return {
		...actual,
		getEntitySourceByIdForUser: (...args: Array<unknown>) =>
			getEntitySourceByIdForUser(...(args as [never])),
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/package-registry/repo.ts')>()
	return {
		...actual,
		getSavedPackageById: (...args: Array<unknown>) =>
			getSavedPackageById(...(args as [never])),
	}
})

vi.mock('./archived-artifacts-repo.ts', () => ({
	listArchivedJobArtifactsDueBefore: (...args: Array<unknown>) =>
		listArchivedJobArtifactsDueBefore(...(args as [never])),
	deleteArchivedJobArtifact: vi.fn(),
}))

const { runDueJobsForUser } = await import('./service.ts')

function createJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		version: 1,
		id: 'job-fenced',
		userId: 'user-fenced',
		name: 'Fenced job',
		sourceId: 'source-fenced',
		publishedCommit: null,
		storageId: 'job:job-fenced',
		schedule: { type: 'interval', every: '1h' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-07-30T12:00:00.000Z',
		updatedAt: '2026-07-30T12:00:00.000Z',
		nextRunAt: '2026-07-30T19:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...overrides,
	}
}

function claimedRow(record: JobRecord) {
	const scheduledFor = record.nextRunAt
	return {
		id: record.id,
		user_id: record.userId,
		name: record.name,
		source_id: record.sourceId,
		published_commit: record.publishedCommit,
		repo_check_policy_json: null,
		storage_id: record.storageId,
		params_json: null,
		schedule_json: JSON.stringify(record.schedule),
		timezone: record.timezone,
		enabled: 1 as const,
		kill_switch_enabled: 0 as const,
		preserved: 0 as const,
		expires_at: null,
		caller_context_json: '{}',
		created_at: record.createdAt,
		updated_at: record.updatedAt,
		last_run_at: null,
		last_run_status: null,
		next_run_at: record.nextRunAt,
		claim_token: 'claim-token',
		running_since: scheduledFor,
		lease_expires_at: '2026-07-30T19:10:00.000Z',
		claimed_scheduled_for: scheduledFor,
		retry_scheduled_for: null,
		retry_count: 0,
		last_completed_scheduled_for: null,
		schedulerWakeAt: scheduledFor,
		record,
		callerContext: null,
		callerContextJson: '{}',
	}
}

test('runDueJobsForUser treats superseded finalization and retry claims as expected fencing', async () => {
	const now = new Date('2026-07-30T19:00:00.000Z')
	const env = { APP_DB: {} } as Env

	const finalizeRecord = createJobRecord()
	const finalizeRow = claimedRow(finalizeRecord)
	listDueJobRows.mockResolvedValue([finalizeRow])
	claimJobRow.mockResolvedValue(finalizeRow)
	claimRunRecord.mockResolvedValue({
		claimed: false,
		run: {
			id: 'run-1',
			surface: 'job',
			status: 'success',
			name: finalizeRecord.name,
			packageId: null,
			kodyId: null,
			sourceId: finalizeRecord.sourceId,
			publishedCommit: null,
			storageId: finalizeRecord.storageId,
			jobId: finalizeRecord.id,
			workflowId: null,
			invocationId: null,
			sessionId: null,
			idempotencyKey: `scheduled-job:${finalizeRecord.id}:${finalizeRow.claimed_scheduled_for}`,
			parentRunId: null,
			startedAt: now.toISOString(),
			finishedAt: now.toISOString(),
			durationMs: 12,
			errorName: null,
			errorMessage: null,
			metadata: { result: { ok: true } },
			logCount: 0,
		},
	})
	finalizeClaimedJobRow.mockResolvedValue(false)

	await expect(
		runDueJobsForUser({
			env,
			userId: finalizeRecord.userId,
			now,
		}),
	).resolves.toEqual({
		dueJobCount: 1,
		successCount: 0,
		errorCount: 0,
		jobOutcomes: [],
	})
	expect(finalizeClaimedJobRow).toHaveBeenCalledOnce()
	expect(finalizeClaimedJobRow).toHaveBeenCalledWith(
		expect.objectContaining({
			job: expect.objectContaining({
				lastRunStatus: 'success',
				lastRunAt: expect.any(String),
				// Scheduling finalization must not bump RunLog-owned counters.
				runCount: 0,
				successCount: 0,
				errorCount: 0,
			}),
		}),
	)
	expect(retryClaimedJobRow).not.toHaveBeenCalled()
	expect(consoleInfo).toHaveBeenCalledWith(
		'job-scheduler',
		expect.stringContaining('"event":"claim_lost_before_finalization"'),
	)

	finalizeClaimedJobRow.mockClear()
	retryClaimedJobRow.mockClear()
	consoleInfo.mockClear()

	const retryRecord = createJobRecord({ id: 'job-retry-fence' })
	const retryRow = claimedRow(retryRecord)
	listDueJobRows.mockResolvedValue([retryRow])
	claimJobRow.mockResolvedValue(retryRow)
	claimRunRecord.mockResolvedValue(null)
	retryClaimedJobRow.mockResolvedValue(false)

	await expect(
		runDueJobsForUser({
			env,
			userId: retryRecord.userId,
			now,
		}),
	).resolves.toEqual({
		dueJobCount: 1,
		successCount: 0,
		errorCount: 0,
		jobOutcomes: [],
	})
	expect(retryClaimedJobRow).toHaveBeenCalledOnce()
	expect(finalizeClaimedJobRow).not.toHaveBeenCalled()
	expect(consoleInfo).toHaveBeenCalledWith(
		'job-scheduler',
		expect.stringContaining('"event":"claim_lost_before_retry_transition"'),
	)
})

test('scheduled package job claims carry package identity and the published source commit', async () => {
	const now = new Date('2026-07-30T19:00:00.000Z')
	const packageId = '11c7ff51-aa34-4ab8-94d6-bdd5e6af6d40'
	const record = createJobRecord({
		id: `package-job:${packageId}:archive-sync`,
		name: 'archive-sync',
		sourceId: 'source-package',
		publishedCommit: null,
	})
	const row = claimedRow(record)
	listDueJobRows.mockReset()
	claimJobRow.mockReset()
	claimRunRecord.mockReset()
	finalizeClaimedJobRow.mockReset()
	listDueJobRows.mockResolvedValue([row])
	claimJobRow.mockResolvedValue(row)
	getEntitySourceByIdForUser.mockResolvedValue({
		id: record.sourceId,
		user_id: record.userId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: 'repo-package',
		published_commit: 'published-package-commit',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: now.toISOString(),
		updated_at: now.toISOString(),
	})
	getSavedPackageById.mockResolvedValue({
		id: packageId,
		userId: record.userId,
		kodyId: 'tesla-solar',
	})
	claimRunRecord.mockResolvedValue({
		claimed: false,
		run: {
			id: 'run-package',
			surface: 'job',
			status: 'success',
			name: record.name,
			packageId,
			kodyId: 'tesla-solar',
			sourceId: record.sourceId,
			publishedCommit: 'published-package-commit',
			storageId: record.storageId,
			jobId: record.id,
			workflowId: null,
			invocationId: null,
			sessionId: null,
			idempotencyKey: `scheduled-job:${record.id}:${row.claimed_scheduled_for}`,
			parentRunId: null,
			startedAt: now.toISOString(),
			finishedAt: now.toISOString(),
			durationMs: 12,
			errorName: null,
			errorMessage: null,
			metadata: { result: { ok: true } },
			logCount: 0,
		},
	})
	finalizeClaimedJobRow.mockResolvedValue(true)

	await runDueJobsForUser({
		env: { APP_DB: {} } as Env,
		userId: record.userId,
		now,
	})

	expect(getEntitySourceByIdForUser).toHaveBeenCalledWith(expect.anything(), {
		id: record.sourceId,
		userId: record.userId,
	})
	expect(getSavedPackageById).toHaveBeenCalledWith(expect.anything(), {
		userId: record.userId,
		packageId,
	})
	expect(claimRunRecord).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: record.userId,
		context: expect.objectContaining({
			surface: 'job',
			jobId: record.id,
			packageId,
			kodyId: 'tesla-solar',
			sourceId: record.sourceId,
			publishedCommit: 'published-package-commit',
		}),
	})

	claimRunRecord.mockClear()
	retryClaimedJobRow.mockReset()
	retryClaimedJobRow.mockResolvedValue(true)
	listDueJobRows.mockResolvedValue([row])
	claimJobRow.mockResolvedValue(row)
	getEntitySourceByIdForUser.mockRejectedValueOnce(
		new TransientJobExecutionError('D1_ERROR: Network connection lost.'),
	)

	await expect(
		runDueJobsForUser({
			env: { APP_DB: {} } as Env,
			userId: record.userId,
			now,
		}),
	).resolves.toEqual({
		dueJobCount: 1,
		successCount: 0,
		errorCount: 1,
		jobOutcomes: [
			{
				jobId: record.id,
				scheduleType: 'interval',
				outcome: 'failure',
				nextRunAt: '2026-07-30T19:00:05.000Z',
				deleted: false,
				error: 'D1_ERROR: Network connection lost.',
			},
		],
	})
	expect(claimRunRecord).not.toHaveBeenCalled()
	expect(retryClaimedJobRow).toHaveBeenCalledWith(
		expect.objectContaining({
			jobId: record.id,
			claimToken: expect.any(String),
			nextRunAt: '2026-07-30T19:00:05.000Z',
		}),
	)
})
