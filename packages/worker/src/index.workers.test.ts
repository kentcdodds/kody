import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { createExecutionContext, env } from 'cloudflare:test'
import { oauthPurgeContinuationKey } from './oauth-purge.ts'

const mocks = vi.hoisted(() => ({
	reconcileArtifactsPushes: vi.fn(async () => ({})),
	cleanupRepoSessionBranches: vi.fn(async () => ({})),
	pruneSystemEmailRetention: vi.fn(async () => ({})),
	pruneRetention: vi.fn(async () => ({})),
	shouldRunRetentionCron: vi.fn(() => false),
	aggregateUsageRollups: vi.fn(async () => ({ skipped: true })),
	shouldRunUsageAggregationCron: vi.fn(() => false),
	refreshStaleStripePlans: vi.fn(async () => ({
		refreshed: 0,
		failed: 0,
		skipped: true,
	})),
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

vi.mock('#worker/billing/subscription-sync.ts', () => ({
	refreshStaleStripePlans: mocks.refreshStaleStripePlans,
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
	expect(mocks.refreshStaleStripePlans).toHaveBeenCalledWith(
		expect.objectContaining({ now: new Date(scheduledTime) }),
	)
	expect(mocks.pruneRetention).not.toHaveBeenCalled()
})

test('scheduled OAuth purge advances past healthy grant and token pages', async () => {
	const scheduledTime = Date.parse('2026-07-05T10:05:00.000Z')
	const userId = 'oauth-purge-user'
	const clientId = 'oauth-purge-client'
	const healthyGrantIds = Array.from(
		{ length: 51 },
		(_, index) => `${index.toString().padStart(3, '0')}-healthy`,
	)
	const orphanGrantId = 'zzz-orphan'
	const orphanGrantKey = `grant:${userId}:${orphanGrantId}`
	const orphanTokenKey = `token:${userId}:${orphanGrantId}:orphan-token`

	await env.OAUTH_KV.delete(oauthPurgeContinuationKey)
	await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify({ clientId }))
	await Promise.all(
		healthyGrantIds.flatMap((grantId) => [
			env.OAUTH_KV.put(
				`grant:${userId}:${grantId}`,
				JSON.stringify({ id: grantId, userId, clientId }),
			),
			env.OAUTH_KV.put(
				`token:${userId}:${grantId}:healthy-token`,
				JSON.stringify({ userId, grantId }),
			),
		]),
	)
	await env.OAUTH_KV.put(
		orphanGrantKey,
		JSON.stringify({
			id: orphanGrantId,
			userId,
			clientId: 'missing-client',
		}),
	)
	await env.OAUTH_KV.put(
		orphanTokenKey,
		JSON.stringify({ userId, grantId: orphanGrantId }),
	)

	await worker.scheduled?.(
		createController(scheduledTime),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 5 * 60_000),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanTokenKey)).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 10 * 60_000),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKey)).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 15 * 60_000),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanTokenKey)).toBeNull()
	expect(
		await env.OAUTH_KV.get(`grant:${userId}:${healthyGrantIds.at(-1)}`),
	).not.toBeNull()
	expect(
		await env.OAUTH_KV.get(
			`token:${userId}:${healthyGrantIds.at(-1)}:healthy-token`,
		),
	).not.toBeNull()
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
