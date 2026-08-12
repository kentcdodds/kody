import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import { env, runInDurableObject } from 'cloudflare:test'
import type * as SystemEmail from '#worker/email/system-email.ts'
import {
	oauthPurgeContinuationStorageKey,
	type OAuthPurgeCoordinator,
	type PurgeContinuation,
} from './oauth-purge.ts'

const mocks = vi.hoisted(() => ({
	reconcileArtifactsPushes: vi.fn(async () => ({})),
	sweepStaleInboundDeliveries: vi.fn(async () => ({})),
	cleanupRepoSessionBranches: vi.fn(async () => ({})),
	pruneSystemEmailRetention: vi.fn(async () => ({})),
	pruneRetention: vi.fn(async () => ({})),
	pruneJobRetention: vi.fn(async () => ({})),
	checkAuthDenialBurstAndNotify: vi.fn(async () => ({
		status: 'below_threshold',
		count: 0,
	})),
	aggregateUsageRollups: vi.fn(async () => ({ skipped: true })),
	backfillStorageBucketEstimates: vi.fn(async () => ({
		scanned: 0,
		updated: 0,
		failed: 0,
	})),
	reconcileD1StorageBytes: vi.fn(async () => ({
		scanned: 0,
		updated: 0,
		failed: 0,
	})),
}))

vi.mock('./jobs/reconcile-artifacts-pushes.ts', () => ({
	reconcileArtifactsPushes: mocks.reconcileArtifactsPushes,
}))

vi.mock('./repo/repo-session-cleanup.ts', () => ({
	cleanupRepoSessionBranches: mocks.cleanupRepoSessionBranches,
}))

vi.mock('#worker/email/system-email.ts', async (importOriginal) => ({
	...(await importOriginal<typeof SystemEmail>()),
	pruneSystemEmailRetention: mocks.pruneSystemEmailRetention,
}))

vi.mock('#worker/email/reconcile-inbound-deliveries.ts', () => ({
	sweepStaleInboundDeliveries: mocks.sweepStaleInboundDeliveries,
}))

vi.mock('#app/retention.ts', () => ({
	pruneRetention: mocks.pruneRetention,
}))

vi.mock('#worker/jobs/job-retention-cleanup.ts', () => ({
	pruneJobRetention: mocks.pruneJobRetention,
}))

vi.mock('#app/auth-denial-alerts.ts', () => ({
	checkAuthDenialBurstAndNotify: mocks.checkAuthDenialBurstAndNotify,
}))

vi.mock('#worker/usage/aggregate-rollups.ts', () => ({
	aggregateUsageRollups: mocks.aggregateUsageRollups,
}))

vi.mock('#worker/storage-buckets/estimate-backfill.ts', () => ({
	backfillStorageBucketEstimates: mocks.backfillStorageBucketEstimates,
}))

vi.mock('#worker/entitlements/d1-storage-reconciliation.ts', () => ({
	d1StorageReconciliationBatchSize: 8,
	reconcileD1StorageBytes: mocks.reconcileD1StorageBytes,
}))

const { runScheduledLane, runScheduledLaneWithFailureIsolation } =
	await import('./scheduled/scheduled-lanes.ts')

const cron = '*/5 * * * *'

function createMessage(lane: string, scheduledTime: number) {
	return {
		lane,
		scheduledTime,
		cron,
	} as Parameters<typeof runScheduledLaneWithFailureIsolation>[0]['message']
}

function getOAuthPurgeCoordinator() {
	return env.OAUTH_PURGE_COORDINATOR.get(
		env.OAUTH_PURGE_COORDINATOR.idFromName('global'),
	)
}

test('platform lanes execute with their expected inputs and jobs-owned lanes are rejected', async () => {
	const scheduledTime = Date.parse('2026-07-05T10:05:30.000Z')
	const scheduledAt = new Date(scheduledTime)
	for (const lane of [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
		'reconcile_inbound_deliveries',
		'system_email_retention',
		'storage_bucket_estimate_backfill',
		'd1_storage_reconciliation',
		'retention',
		'job_retention',
		'usage_aggregation',
		'auth_denial_alert',
	] as const) {
		await runScheduledLane({ env, lane, scheduledAt })
	}

	expect(mocks.reconcileArtifactsPushes).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.cleanupRepoSessionBranches).toHaveBeenCalledTimes(1)
	expect(mocks.sweepStaleInboundDeliveries).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.pruneSystemEmailRetention).toHaveBeenCalledWith(
		expect.objectContaining({ blobs: env.EMAIL_BLOBS }),
	)
	expect(mocks.aggregateUsageRollups).toHaveBeenCalledWith(env, scheduledAt)
	expect(mocks.checkAuthDenialBurstAndNotify).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.backfillStorageBucketEstimates).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.pruneRetention).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.pruneJobRetention).toHaveBeenCalledWith(
		expect.objectContaining({ now: scheduledAt }),
	)
	expect(mocks.reconcileD1StorageBytes).toHaveBeenCalledTimes(1)
	const reconciliationInput = mocks.reconcileD1StorageBytes.mock.calls[0]?.[0]
	expect(reconciliationInput?.db === env.APP_DB).toBe(true)
	expect(reconciliationInput?.env).toEqual(
		expect.objectContaining({ APP_DB: env.APP_DB }),
	)
	expect(reconciliationInput?.now).toEqual(scheduledAt)

	await expect(
		runScheduledLane({
			env,
			lane: 'job_schedule_watchdog',
			scheduledAt: new Date(),
		}),
	).rejects.toThrow(/owned by the jobs worker/)
})

test('scheduled OAuth purge advances and revokes every grant token before the grant', async () => {
	const scheduledTime = Date.parse('2026-07-05T10:05:00.000Z')
	const userId = 'oauth-purge-user'
	const clientId = 'oauth-purge-client'
	const healthyGrantIds = Array.from(
		{ length: 51 },
		(_, index) => `${index.toString().padStart(3, '0')}-healthy`,
	)
	const orphanGrantId = 'zzz-orphan'
	const orphanGrantKey = `grant:${userId}:${orphanGrantId}`
	const orphanTokenKeys = Array.from(
		{ length: 51 },
		(_, index) =>
			`token:${userId}:${orphanGrantId}:${index.toString().padStart(3, '0')}`,
	)

	await runInDurableObject(
		getOAuthPurgeCoordinator(),
		async (_instance: OAuthPurgeCoordinator, state) =>
			state.storage.deleteAll(),
	)
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
	await Promise.all(
		orphanTokenKeys.map((key) =>
			env.OAUTH_KV.put(key, JSON.stringify({ userId, grantId: orphanGrantId })),
		),
	)

	const runPurgeTick = (tickTime: number) =>
		runScheduledLane({
			env,
			lane: 'oauth_purge_expired',
			scheduledAt: new Date(tickTime),
		})

	await runPurgeTick(scheduledTime)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKeys[0] ?? '')).not.toBeNull()

	await runPurgeTick(scheduledTime + 5 * 60_000)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()

	await runPurgeTick(scheduledTime + 10 * 60_000)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKeys[0] ?? '')).toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKeys.at(-1) ?? '')).not.toBeNull()

	await runPurgeTick(scheduledTime + 15 * 60_000)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()

	await runPurgeTick(scheduledTime + 20 * 60_000)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).toBeNull()
	await expect(
		Promise.all(orphanTokenKeys.map((key) => env.OAUTH_KV.get(key))),
	).resolves.toEqual(orphanTokenKeys.map(() => null))
	expect(
		await env.OAUTH_KV.get(`grant:${userId}:${healthyGrantIds.at(-1)}`),
	).not.toBeNull()
	expect(
		await env.OAUTH_KV.get(
			`token:${userId}:${healthyGrantIds.at(-1)}:healthy-token`,
		),
	).not.toBeNull()
})

test('OAuth purge resets only invalid persisted cursors', async () => {
	const coordinator = getOAuthPurgeCoordinator()
	const invalidCursor = '%%%'
	await runInDurableObject(
		coordinator,
		async (_instance: OAuthPurgeCoordinator, state) => {
			await state.storage.deleteAll()
			await state.storage.put<PurgeContinuation>(
				oauthPurgeContinuationStorageKey,
				{
					version: 1,
					nextPhase: 'grants',
					grantCursor: invalidCursor,
				},
			)
		},
	)
	await env.OAUTH_KV.put(
		'client:cursor-recovery-client',
		JSON.stringify({ clientId: 'cursor-recovery-client' }),
	)
	await env.OAUTH_KV.put(
		'grant:cursor-recovery-user:grant',
		JSON.stringify({ clientId: 'cursor-recovery-client' }),
	)

	const result = await coordinator.run({
		scheduledAt: Date.parse('2026-07-05T11:00:00.000Z'),
	})
	expect(result.phase).toBe('grants')
	expect(result.checked).toBeGreaterThan(0)
	await runInDurableObject(
		coordinator,
		async (_instance: OAuthPurgeCoordinator, state) => {
			const continuation = await state.storage.get<PurgeContinuation>(
				oauthPurgeContinuationStorageKey,
			)
			expect(continuation?.grantCursor).not.toBe(invalidCursor)
			expect(continuation?.nextPhase).toBe('tokens')
		},
	)
})

test('OAuth purge coordinator serializes overlapping invocations', async () => {
	const coordinator = getOAuthPurgeCoordinator()
	await runInDurableObject(
		coordinator,
		async (_instance: OAuthPurgeCoordinator, state) =>
			state.storage.deleteAll(),
	)
	await env.OAUTH_KV.put(
		'client:overlap-client',
		JSON.stringify({ clientId: 'overlap-client' }),
	)
	await Promise.all(
		Array.from({ length: 51 }, (_, index) =>
			env.OAUTH_KV.put(
				`grant:overlap-user:${index.toString().padStart(3, '0')}`,
				JSON.stringify({ clientId: 'overlap-client' }),
			),
		),
	)

	const [first, second] = await Promise.all([
		coordinator.run({ scheduledAt: Date.parse('2026-07-05T11:05:00.000Z') }),
		coordinator.run({ scheduledAt: Date.parse('2026-07-05T11:05:00.000Z') }),
	])

	expect([first.phase, second.phase]).toEqual(['grants', 'tokens'])
	await runInDurableObject(
		coordinator,
		async (_instance: OAuthPurgeCoordinator, state) => {
			const continuation = await state.storage.get<PurgeContinuation>(
				oauthPurgeContinuationStorageKey,
			)
			expect(continuation?.nextPhase).toBe('grants')
			expect(continuation?.grantCursor).toBeTruthy()
		},
	)
})

test('lane failure isolation reports ordinary errors to Sentry and treats D1 lock contention as retryable', async () => {
	const consoleErrorSpy = vi
		.spyOn(console, 'error')
		.mockImplementation(() => {})
	const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const withScope = vi.spyOn(Sentry, 'withScope')
	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')
	mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
		new Error('reconcile exploded'),
	)
	const failedTime = Date.parse('2026-07-05T10:10:00.000Z')

	try {
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: createMessage('reconcile_artifacts_pushes', failedTime),
			}),
		).resolves.toBe('failed')

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'scheduled_lane_failed lane=reconcile_artifacts_pushes',
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
		expect(withScope).toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'reconcile exploded' }),
		)
		const scopeCallback = withScope.mock.calls[0]?.[0] as
			| ((scope: {
					setTag: (key: string, value: string) => void
					setContext: (key: string, value: Record<string, unknown>) => void
			  }) => void)
			| undefined
		expect(scopeCallback).toBeTypeOf('function')
		const setTag = vi.fn()
		const setContext = vi.fn()
		scopeCallback?.({ setTag, setContext })
		expect(setTag).toHaveBeenCalledWith(
			'scheduled.lane',
			'reconcile_artifacts_pushes',
		)
		expect(setContext).toHaveBeenCalledWith(
			'scheduled',
			expect.objectContaining({
				lane: 'reconcile_artifacts_pushes',
				scheduledTime: new Date(failedTime).toISOString(),
				cron,
			}),
		)

		captureException.mockClear()
		mocks.reconcileArtifactsPushes.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		const lockTime = Date.parse('2026-07-05T10:20:00.000Z')
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: createMessage('reconcile_artifacts_pushes', lockTime),
			}),
		).resolves.toBe('d1_lock_contention')

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'scheduled_lane_d1_lock_contention lane=reconcile_artifacts_pushes',
			expect.objectContaining({
				message: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
			}),
		)
		expect(captureException).not.toHaveBeenCalled()
	} finally {
		consoleErrorSpy.mockRestore()
		consoleWarnSpy.mockRestore()
		withScope.mockRestore()
		captureException.mockRestore()
	}
})
