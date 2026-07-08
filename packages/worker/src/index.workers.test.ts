import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { createExecutionContext, env } from 'cloudflare:test'

const mocks = vi.hoisted(() => ({
	reconcileArtifactsPushes: vi.fn(async () => ({})),
	cleanupRepoSessionBranches: vi.fn(async () => ({})),
	pruneSystemEmailRetention: vi.fn(async () => ({})),
	pruneRetention: vi.fn(async () => ({})),
	shouldRunRetentionCron: vi.fn(() => false),
	aggregateUsageRollups: vi.fn(async () => ({ skipped: true })),
	shouldRunUsageAggregationCron: vi.fn(() => false),
}))

vi.mock('./jobs/reconcile-artifacts-pushes.ts', () => ({
	reconcileArtifactsPushes: mocks.reconcileArtifactsPushes,
}))

vi.mock('./repo/repo-session-cleanup.ts', () => ({
	cleanupRepoSessionBranches: mocks.cleanupRepoSessionBranches,
}))

vi.mock('#worker/email/system-email.ts', () => ({
	pruneSystemEmailRetention: mocks.pruneSystemEmailRetention,
}))

vi.mock('#app/retention.ts', () => ({
	pruneRetention: mocks.pruneRetention,
	shouldRunRetentionCron: mocks.shouldRunRetentionCron,
}))

vi.mock('#worker/usage/aggregate-rollups.ts', () => ({
	aggregateUsageRollups: mocks.aggregateUsageRollups,
	shouldRunUsageAggregationCron: mocks.shouldRunUsageAggregationCron,
}))

const worker = (await import('./index.ts')).default

function createController(scheduledTime: number) {
	return {
		scheduledTime,
		cron: '*/5 * * * *',
		noRetry() {},
	} satisfies ScheduledController
}

test('scheduled runs gated lanes and passes EMAIL_BLOBS to system-email retention', async () => {
	mocks.shouldRunUsageAggregationCron.mockReturnValueOnce(true)
	const scheduledTime = Date.parse('2026-07-05T10:00:30.000Z')

	await worker.scheduled?.(
		createController(scheduledTime),
		env,
		createExecutionContext(),
	)

	expect(mocks.reconcileArtifactsPushes).toHaveBeenCalledWith(
		expect.objectContaining({ now: new Date(scheduledTime) }),
	)
	expect(mocks.cleanupRepoSessionBranches).toHaveBeenCalledTimes(1)
	expect(mocks.pruneSystemEmailRetention).toHaveBeenCalledWith(
		expect.objectContaining({ blobs: env.EMAIL_BLOBS }),
	)
	expect(mocks.aggregateUsageRollups).toHaveBeenCalledWith(
		env,
		new Date(scheduledTime),
	)
	expect(mocks.pruneRetention).not.toHaveBeenCalled()
})

test('scheduled isolates a failing lane: logs it and keeps siblings and the invocation alive', async () => {
	const consoleErrorSpy = vi
		.spyOn(console, 'error')
		.mockImplementation(() => {})
	mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
		new Error('reconcile exploded'),
	)
	const scheduledTime = Date.parse('2026-07-05T10:10:00.000Z')

	try {
		await expect(
			worker.scheduled?.(
				createController(scheduledTime),
				env,
				createExecutionContext(),
			),
		).resolves.toBeUndefined()

		expect(mocks.cleanupRepoSessionBranches).toHaveBeenCalled()
		expect(mocks.pruneSystemEmailRetention).toHaveBeenCalled()
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'scheduled_lane_failed lane=reconcile_artifacts_pushes',
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
	} finally {
		consoleErrorSpy.mockRestore()
	}
})

test('scheduled logs D1 lock contention as a warning without reporting to Sentry', async () => {
	const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')
	mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
		new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
	)
	const scheduledTime = Date.parse('2026-07-05T10:20:00.000Z')

	try {
		await worker.scheduled?.(
			createController(scheduledTime),
			env,
			createExecutionContext(),
		)

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'scheduled_lane_d1_lock_contention lane=reconcile_artifacts_pushes',
			expect.objectContaining({
				message: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
			}),
		)
		expect(captureException).not.toHaveBeenCalled()
		expect(mocks.cleanupRepoSessionBranches).toHaveBeenCalled()
	} finally {
		consoleWarnSpy.mockRestore()
		captureException.mockRestore()
	}
})
