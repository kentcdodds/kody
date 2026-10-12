import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type EnablementRun } from '#worker/request-context/request-context.ts'
import { expect, test, vi } from 'vitest'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { type JobRecord } from './types.ts'
import { TransientJobExecutionError } from './execution-safety.ts'
import type * as JobsRepo from '@kody-internal/shared/jobs/repo.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import type * as EntitySources from '#worker/repo/entity-sources.ts'
import type * as PackageRegistryRepo from '#worker/package-registry/repo.ts'

const withAccountWriteLease = vi.fn(
	async (input: { write: () => Promise<unknown> }) => input.write(),
)
const disableExpiredJobRowsForUser = vi.fn<
	typeof JobsRepo.disableExpiredJobRowsForUser
>(async () => 0)
const listDueJobRows = vi.fn()
const claimJobRow = vi.fn()
const finalizeClaimedJobRow = vi.fn()
const retryClaimedJobRow = vi.fn()
const renewClaimedJobRow = vi.fn()
const claimRunRecord = vi.fn()
const getEntitySourceByIdForUser = vi.fn()
const getSavedPackageById = vi.fn()

const enablementRun: EnablementRun = {
	id: 'enablement-fenced',
	enabler: { userId: personIdFromStored('user-fenced'), username: 'fenced' },
	role: 'owner',
}
const planEnablementRuns = vi.fn(
	async (): Promise<{ runs: Array<EnablementRun>; skipped: [] }> => ({
		runs: [enablementRun],
		skipped: [],
	}),
)

vi.mock('#worker/enablements/run-gate.ts', () => ({
	planEnablementRuns: () => planEnablementRuns(),
}))

vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: (...args: Array<unknown>) =>
		withAccountWriteLease(...(args as [never])),
}))

vi.mock('@kody-internal/shared/jobs/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof JobsRepo>()
	return {
		...actual,
		disableExpiredJobRowsForUser: (
			...args: Parameters<typeof JobsRepo.disableExpiredJobRowsForUser>
		) => disableExpiredJobRowsForUser(...args),
		listDueJobRows: (...args: Array<unknown>) =>
			listDueJobRows(...(args as [never])),
		claimJobRow: (...args: Array<unknown>) => claimJobRow(...(args as [never])),
		finalizeClaimedJobRow: (...args: Array<unknown>) =>
			finalizeClaimedJobRow(...(args as [never])),
		retryClaimedJobRow: (...args: Array<unknown>) =>
			retryClaimedJobRow(...(args as [never])),
		renewClaimedJobRow: (...args: Array<unknown>) =>
			renewClaimedJobRow(...(args as [never])),
	}
})

vi.mock('#worker/run-records/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RunRecordsServiceModule>()
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
	const actual = await importOriginal<typeof EntitySources>()
	return {
		...actual,
		getEntitySourceByIdForUser: (...args: Array<unknown>) =>
			getEntitySourceByIdForUser(...(args as [never])),
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageRegistryRepo>()
	return {
		...actual,
		getSavedPackageById: (...args: Array<unknown>) =>
			getSavedPackageById(...(args as [never])),
	}
})

const { runDueJobsForUser } = await import('./service.ts')

function createJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		version: 1,
		id: 'package-job:pkg-fenced:fenced-job',
		userId: ownerIdFromStored('user-fenced'),
		name: 'Fenced job',
		sourceId: 'source-fenced',
		publishedCommit: null,
		storageId: 'job:package-job:pkg-fenced:fenced-job',
		schedule: { type: 'interval', every: '1h' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
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

const now = new Date('2026-07-30T19:00:00.000Z')

/** A claimRunRecord result where another attempt already recorded success. */
function alreadyRecordedRun(
	record: JobRecord,
	row: ReturnType<typeof claimedRow>,
	identity: {
		packageId: string | null
		kodyId: string | null
		publishedCommit: string | null
	},
) {
	return {
		claimed: false,
		run: {
			id: `run-${record.id}`,
			surface: 'job',
			status: 'success',
			name: record.name,
			...identity,
			sourceId: record.sourceId,
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
	}
}

function seedDueClaim(record: JobRecord) {
	const row = claimedRow(record)
	listDueJobRows.mockResolvedValue([row])
	claimJobRow.mockResolvedValue(row)
	return row
}

function runDue(userId: string) {
	return runDueJobsForUser({
		env: { APP_DB: {} } as Env,
		userId: ownerIdFromStored(userId),
		now,
	})
}

const fencedOutcome = {
	dueJobCount: 1,
	successCount: 0,
	errorCount: 0,
	jobOutcomes: [],
}

test('runDueJobsForUser treats superseded finalization and retry claims as expected fencing', async () => {
	const finalizeRecord = createJobRecord()
	const finalizeRow = seedDueClaim(finalizeRecord)
	claimRunRecord.mockResolvedValue(
		alreadyRecordedRun(finalizeRecord, finalizeRow, {
			packageId: null,
			kodyId: null,
			publishedCommit: null,
		}),
	)
	finalizeClaimedJobRow.mockResolvedValue(false)

	await expect(runDue(finalizeRecord.userId)).resolves.toEqual(fencedOutcome)
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

	const retryRecord = createJobRecord({
		id: 'package-job:pkg-fenced:retry-fence',
	})
	seedDueClaim(retryRecord)
	claimRunRecord.mockResolvedValue(null)
	retryClaimedJobRow.mockResolvedValue(false)

	await expect(runDue(retryRecord.userId)).resolves.toEqual(fencedOutcome)
	expect(retryClaimedJobRow).toHaveBeenCalledOnce()
	expect(finalizeClaimedJobRow).not.toHaveBeenCalled()
	expect(consoleInfo).toHaveBeenCalledWith(
		'job-scheduler',
		expect.stringContaining('"event":"claim_lost_before_retry_transition"'),
	)
})

test('scheduled package job claims carry package identity and the published source commit', async () => {
	const packageId = '11c7ff51-aa34-4ab8-94d6-bdd5e6af6d40'
	const record = createJobRecord({
		id: `package-job:${packageId}:archive-sync`,
		name: 'archive-sync',
		sourceId: 'source-package',
		publishedCommit: null,
	})
	const row = seedDueClaim(record)
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
	claimRunRecord.mockResolvedValue(
		alreadyRecordedRun(record, row, {
			packageId,
			kodyId: 'tesla-solar',
			publishedCommit: 'published-package-commit',
		}),
	)
	finalizeClaimedJobRow.mockResolvedValue(true)

	await runDue(record.userId)

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
	retryClaimedJobRow.mockResolvedValue(true)
	getEntitySourceByIdForUser.mockRejectedValueOnce(
		new TransientJobExecutionError('D1_ERROR: Network connection lost.'),
	)

	await expect(runDue(record.userId)).resolves.toEqual({
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

test('a scheduled slot with no enablement on records no run and does not use up a once job', async () => {
	planEnablementRuns.mockResolvedValueOnce({ runs: [], skipped: [] })
	planEnablementRuns.mockResolvedValueOnce({ runs: [], skipped: [] })
	claimRunRecord.mockClear()
	finalizeClaimedJobRow.mockReset()
	retryClaimedJobRow.mockReset()
	finalizeClaimedJobRow.mockResolvedValue(true)
	retryClaimedJobRow.mockResolvedValue(true)
	const skipped = {
		dueJobCount: 1,
		successCount: 0,
		errorCount: 0,
		jobOutcomes: [],
	}

	const recurring = createJobRecord({
		id: 'package-job:pkg-fenced:recurring-skip',
	})
	seedDueClaim(recurring)
	await expect(runDue(recurring.userId)).resolves.toEqual(skipped)
	expect(finalizeClaimedJobRow).toHaveBeenCalledOnce()
	const finalized = finalizeClaimedJobRow.mock.calls[0]?.[0] as {
		job: JobRecord
	}
	expect(finalized.job).toMatchObject({
		enabled: true,
		nextRunAt: '2026-07-30T20:00:00.000Z',
	})
	expect(finalized.job.lastRunAt).toBeUndefined()
	expect(finalized.job.lastRunStatus).toBeUndefined()
	expect(retryClaimedJobRow).not.toHaveBeenCalled()

	finalizeClaimedJobRow.mockClear()
	const once = createJobRecord({
		id: 'package-job:pkg-fenced:once-skip',
		schedule: { type: 'once', runAt: '2026-07-30T19:00:00.000Z' },
	})
	seedDueClaim(once)
	await expect(runDue(once.userId)).resolves.toEqual(skipped)
	expect(finalizeClaimedJobRow).not.toHaveBeenCalled()
	expect(retryClaimedJobRow).toHaveBeenCalledWith(
		expect.objectContaining({
			jobId: once.id,
			nextRunAt: '2026-07-30T19:00:05.000Z',
		}),
	)
	expect(claimRunRecord).not.toHaveBeenCalled()
})

test('each further enablement run renews the shared claim and stops once it is lost', async () => {
	const secondEnablement: EnablementRun = {
		...enablementRun,
		id: 'enablement-second',
	}
	const record = createJobRecord({
		id: 'package-job:pkg-fenced:multi-enablement',
	})
	const row = seedDueClaim(record)
	claimRunRecord.mockReset()
	claimRunRecord.mockResolvedValue(
		alreadyRecordedRun(record, row, {
			packageId: null,
			kodyId: null,
			publishedCommit: null,
		}),
	)
	finalizeClaimedJobRow.mockReset()
	finalizeClaimedJobRow.mockResolvedValue(true)
	const twoRuns = {
		runs: [enablementRun, secondEnablement],
		skipped: [] as [],
	}

	planEnablementRuns.mockResolvedValueOnce(twoRuns)
	renewClaimedJobRow.mockResolvedValueOnce(true)
	await runDue(record.userId)
	const [claimInput] = claimJobRow.mock.lastCall as [{ claimToken: string }]
	const claimToken = claimInput.claimToken
	expect(renewClaimedJobRow).toHaveBeenCalledOnce()
	expect(renewClaimedJobRow).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: record.userId,
			jobId: record.id,
			claimToken,
			nowMs: expect.any(Number),
		}),
	)
	expect(claimRunRecord).toHaveBeenCalledTimes(2)

	renewClaimedJobRow.mockReset()
	claimRunRecord.mockClear()
	planEnablementRuns.mockResolvedValueOnce(twoRuns)
	renewClaimedJobRow.mockResolvedValueOnce(false)
	await runDue(record.userId)
	expect(renewClaimedJobRow).toHaveBeenCalledOnce()
	expect(claimRunRecord).toHaveBeenCalledOnce()
})
