import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import {
	createExecutionContext,
	env,
	runInDurableObject,
} from 'cloudflare:test'
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
	shouldRunRetentionCron: vi.fn(() => false),
	aggregateUsageRollups: vi.fn(async () => ({ skipped: true })),
	shouldRunUsageAggregationCron: vi.fn(() => false),
	runDrExportTick: vi.fn(async () => ({ skipped: true })),
	shouldRunDrExportCron: vi.fn(() => false),
	isDrExportConfigured: vi.fn(() => false),
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

vi.mock('#worker/email/reconcile-inbound-deliveries.ts', () => ({
	sweepStaleInboundDeliveries: mocks.sweepStaleInboundDeliveries,
}))

vi.mock('#app/retention.ts', () => ({
	pruneRetention: mocks.pruneRetention,
	shouldRunRetentionCron: mocks.shouldRunRetentionCron,
}))

vi.mock('#worker/usage/aggregate-rollups.ts', () => ({
	aggregateUsageRollups: mocks.aggregateUsageRollups,
	shouldRunUsageAggregationCron: mocks.shouldRunUsageAggregationCron,
}))

vi.mock('#worker/dr/exporter.ts', () => ({
	runDrExportTick: mocks.runDrExportTick,
	shouldRunDrExportCron: mocks.shouldRunDrExportCron,
	isDrExportConfigured: mocks.isDrExportConfigured,
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

function getOAuthPurgeCoordinator() {
	return env.OAUTH_PURGE_COORDINATOR.get(
		env.OAUTH_PURGE_COORDINATOR.idFromName('global'),
	)
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
	expect(mocks.sweepStaleInboundDeliveries).toHaveBeenCalledWith(
		expect.objectContaining({
			now: new Date(scheduledTime),
		}),
	)
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

	await worker.scheduled?.(
		createController(scheduledTime),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKeys[0] ?? '')).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 5 * 60_000),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 10 * 60_000),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKeys[0] ?? '')).toBeNull()
	expect(await env.OAUTH_KV.get(orphanTokenKeys.at(-1) ?? '')).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 15 * 60_000),
		env,
		createExecutionContext(),
	)
	expect(await env.OAUTH_KV.get(orphanGrantKey)).not.toBeNull()

	await worker.scheduled?.(
		createController(scheduledTime + 20 * 60_000),
		env,
		createExecutionContext(),
	)
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

test('scheduled isolates a failing lane: logs it and keeps siblings and the invocation alive', async () => {
	const consoleErrorSpy = vi
		.spyOn(console, 'error')
		.mockImplementation(() => {})
	const withScope = vi.spyOn(Sentry, 'withScope')
	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')
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
				scheduledTime: new Date(scheduledTime).toISOString(),
				cron: '*/5 * * * *',
			}),
		)
	} finally {
		consoleErrorSpy.mockRestore()
		withScope.mockRestore()
		captureException.mockRestore()
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
