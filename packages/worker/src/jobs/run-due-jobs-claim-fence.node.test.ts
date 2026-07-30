import { expect, test, vi } from 'vitest'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { type JobRecord } from './types.ts'

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

vi.mock('#worker/run-records/service.ts', () => ({
	claimRunRecord: (...args: Array<unknown>) =>
		claimRunRecord(...(args as [never])),
	abandonRunRecord: vi.fn(),
	finishRunRecord: vi.fn(),
	getRunRecord: vi.fn(),
}))

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
		last_run_error: null,
		last_duration_ms: null,
		next_run_at: record.nextRunAt,
		run_count: 0,
		success_count: 0,
		error_count: 0,
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

test('runDueJobsForUser treats a superseded finalization claim as expected fencing', async () => {
	const now = new Date('2026-07-30T19:00:00.000Z')
	const record = createJobRecord()
	const row = claimedRow(record)
	listDueJobRows.mockResolvedValue([row])
	claimJobRow.mockResolvedValue(row)
	claimRunRecord.mockResolvedValue({
		claimed: false,
		run: {
			id: 'run-1',
			surface: 'job',
			status: 'success',
			name: record.name,
			packageId: null,
			kodyId: null,
			sourceId: record.sourceId,
			publishedCommit: null,
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
	finalizeClaimedJobRow.mockResolvedValue(false)

	const result = await runDueJobsForUser({
		env: { APP_DB: {} } as Env,
		userId: record.userId,
		now,
	})

	expect(result).toEqual({
		dueJobCount: 1,
		successCount: 0,
		errorCount: 0,
		jobOutcomes: [],
	})
	expect(finalizeClaimedJobRow).toHaveBeenCalledOnce()
	expect(retryClaimedJobRow).not.toHaveBeenCalled()
	expect(consoleInfo).toHaveBeenCalledWith(
		'job-scheduler',
		expect.stringContaining('"event":"claim_lost_before_finalization"'),
	)
})

test('runDueJobsForUser treats a superseded retry claim as expected fencing', async () => {
	const now = new Date('2026-07-30T19:00:00.000Z')
	const record = createJobRecord({ id: 'job-retry-fence' })
	const row = claimedRow(record)
	listDueJobRows.mockResolvedValue([row])
	claimJobRow.mockResolvedValue(row)
	claimRunRecord.mockResolvedValue(null)
	retryClaimedJobRow.mockResolvedValue(false)

	const result = await runDueJobsForUser({
		env: { APP_DB: {} } as Env,
		userId: record.userId,
		now,
	})

	expect(result).toEqual({
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
