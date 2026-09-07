import { readFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import {
	consoleError,
	consoleWarn,
	silenceExpectedConsoleErrors,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import {
	getScheduledLaneCadence,
	scheduledDispatchMaxRetries,
	type ScheduledLaneMessage,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { type JobsWorkerEnv } from './env.ts'
import {
	dispatchScheduledLanes,
	handleScheduledDispatchQueue,
	runScheduledLaneWithFailureIsolation,
} from './scheduled.ts'

vi.mock('./watchdog.ts', () => ({
	runJobScheduleWatchdogTick: vi.fn().mockResolvedValue({
		overdueJobCount: 0,
		stuckSkippedJobCount: 0,
		repairedStuckJobCount: 0,
		usersSynced: 0,
		usersFailedSync: 0,
		usersSkippedCap: 0,
		scanTruncated: false,
		alerted: false,
	}),
}))

const { runJobScheduleWatchdogTick } = await import('./watchdog.ts')

function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		JOBS_DB: {} as D1Database,
		JOB_MANAGER: {} as DurableObjectNamespace,
		HOST: {
			runScheduledLane: vi.fn().mockResolvedValue('completed'),
		},
		...overrides,
	} as unknown as JobsWorkerEnv
}

function message(
	lane: ScheduledLaneMessage['lane'],
	scheduledTime = Date.UTC(2026, 0, 1, 12, 0),
): ScheduledLaneMessage {
	return { lane, scheduledTime, cron: '*/5 * * * *' }
}

function queueMessage(input: {
	id?: string
	body: unknown
	attempts?: number
}) {
	return {
		id: input.id ?? 'msg',
		body: input.body,
		attempts: input.attempts ?? 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

test('lane routing forwards platform work to HOST, runs watchdog locally, and acks invalid queue bodies', async () => {
	vi.mocked(runJobScheduleWatchdogTick).mockClear()
	const env = createEnv()
	await expect(
		runScheduledLaneWithFailureIsolation({
			env,
			message: message('oauth_purge_expired'),
		}),
	).resolves.toBe('completed')
	expect(env.HOST.runScheduledLane).toHaveBeenCalledWith(
		message('oauth_purge_expired'),
	)
	expect(runJobScheduleWatchdogTick).not.toHaveBeenCalled()

	vi.mocked(runJobScheduleWatchdogTick).mockClear()
	vi.mocked(env.HOST.runScheduledLane).mockClear()
	await expect(
		runScheduledLaneWithFailureIsolation({
			env,
			message: message('job_schedule_watchdog'),
		}),
	).resolves.toBe('completed')
	expect(runJobScheduleWatchdogTick).toHaveBeenCalledOnce()
	expect(env.HOST.runScheduledLane).not.toHaveBeenCalled()

	consoleError.mockImplementation(() => {})
	const invalidAck = vi.fn()
	const validAck = vi.fn()
	vi.mocked(env.HOST.runScheduledLane).mockClear()
	await handleScheduledDispatchQueue(
		{
			messages: [
				{ id: 'bad', body: { lane: 'nope' }, ack: invalidAck },
				{
					id: 'good',
					body: message('repo_session_cleanup'),
					ack: validAck,
				},
			],
		} as unknown as MessageBatch<unknown>,
		env,
	)
	expect(invalidAck).toHaveBeenCalledOnce()
	expect(validAck).toHaveBeenCalledOnce()
	expect(env.HOST.runScheduledLane).toHaveBeenCalledTimes(1)
	expect(env.HOST.runScheduledLane).toHaveBeenCalledWith(
		message('repo_session_cleanup'),
	)
})

test('cron dispatch enqueues cadence lanes and falls back when the queue is missing or send fails', async () => {
	const send = vi.fn().mockResolvedValue(undefined)
	const queuedEnv = createEnv({ SCHEDULED_DISPATCH_QUEUE: { send } })
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	await dispatchScheduledLanes({
		controller: { scheduledTime, cron: '*/5 * * * *' } as ScheduledController,
		env: queuedEnv,
	})
	const lanes = getScheduledLaneCadence(new Date(scheduledTime))
	expect(send).toHaveBeenCalledTimes(lanes.length)
	expect(send).toHaveBeenCalledWith({
		lane: 'retention',
		scheduledTime,
		cron: '*/5 * * * *',
	})
	expect(send).toHaveBeenCalledWith({
		lane: 'unverified_account_purge',
		scheduledTime,
		cron: '*/5 * * * *',
	})
	expect(queuedEnv.HOST.runScheduledLane).not.toHaveBeenCalled()

	const directEnv = createEnv()
	const directTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatchScheduledLanes({
		controller: {
			scheduledTime: directTime,
			cron: '*/5 * * * *',
		} as ScheduledController,
		env: directEnv,
	})
	const directLanes = getScheduledLaneCadence(new Date(directTime))
	expect(directEnv.HOST.runScheduledLane).toHaveBeenCalledTimes(
		directLanes.length,
	)

	consoleError.mockImplementation(() => {})
	const failingSend = vi.fn(async (body: ScheduledLaneMessage) => {
		if (body.lane === 'oauth_purge_expired') {
			throw new Error('queue unavailable')
		}
	})
	const fallbackEnv = createEnv({
		SCHEDULED_DISPATCH_QUEUE: { send: failingSend },
	})
	const fallbackTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatchScheduledLanes({
		controller: {
			scheduledTime: fallbackTime,
			cron: '*/5 * * * *',
		} as ScheduledController,
		env: fallbackEnv,
	})
	expect(fallbackEnv.HOST.runScheduledLane).toHaveBeenCalledTimes(1)
	expect(fallbackEnv.HOST.runScheduledLane).toHaveBeenCalledWith({
		lane: 'oauth_purge_expired',
		scheduledTime: fallbackTime,
		cron: '*/5 * * * *',
	})
})

test('retryable D1 lock contention is distinguished from ordinary failures', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const env = createEnv({
		HOST: {
			runScheduledLane: vi
				.fn()
				.mockRejectedValue(new Error('D1_ERROR: database is locked')),
		},
	})
	await expect(
		runScheduledLaneWithFailureIsolation({
			env,
			message: message('retention'),
		}),
	).resolves.toBe('d1_lock_contention')

	const failingEnv = createEnv({
		HOST: {
			runScheduledLane: vi.fn().mockRejectedValue(new Error('boom')),
		},
	})
	await expect(
		runScheduledLaneWithFailureIsolation({
			env: failingEnv,
			message: message('retention'),
		}),
	).resolves.toBe('failed')
})

test('queue consumer acks completed and terminal work, retries lock contention with backoff, and preserves scheduledTime', async () => {
	silenceExpectedConsoleWarns([
		'scheduled_lane_d1_lock_contention lane=retention',
	])
	silenceExpectedConsoleErrors([
		'scheduled_lane_failed lane=retention',
		'scheduled_lane_message_invalid',
		'scheduled_lane_terminal_not_retried',
		'scheduled_lane_retry_exhausted',
	])
	const captureMessage = vi.spyOn(Sentry, 'captureMessage')
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	const retention = message('retention', scheduledTime)
	const host = vi
		.fn()
		.mockResolvedValueOnce('completed')
		.mockResolvedValueOnce('d1_lock_contention')
		.mockResolvedValueOnce('failed')
		.mockResolvedValueOnce('d1_lock_contention')
	const env = createEnv({ HOST: { runScheduledLane: host } })

	const completed = queueMessage({ id: 'completed', body: retention })
	const lock = queueMessage({ id: 'lock', body: retention, attempts: 1 })
	const failed = queueMessage({ id: 'failed', body: retention })
	const invalid = queueMessage({
		id: 'invalid',
		body: { lane: 'nope' },
	})
	const exhausted = queueMessage({
		id: 'exhausted',
		body: retention,
		attempts: scheduledDispatchMaxRetries + 1,
	})

	await handleScheduledDispatchQueue(
		{
			messages: [completed, lock, failed, invalid, exhausted],
		} as unknown as MessageBatch<unknown>,
		env,
	)

	expect(completed.ack).toHaveBeenCalledOnce()
	expect(completed.retry).not.toHaveBeenCalled()

	expect(lock.retry).toHaveBeenCalledOnce()
	expect(lock.retry).toHaveBeenCalledWith({ delaySeconds: 10 })
	expect(lock.ack).not.toHaveBeenCalled()

	expect(failed.ack).toHaveBeenCalledOnce()
	expect(failed.retry).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_terminal_not_retried',
		expect.objectContaining({
			lane: 'retention',
			scheduledTime,
			attempts: 1,
			outcome: 'failed',
		}),
	)

	expect(invalid.ack).toHaveBeenCalledOnce()
	expect(invalid.retry).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_message_invalid',
		expect.objectContaining({ queueMessageId: 'invalid' }),
	)

	expect(exhausted.retry).toHaveBeenCalledOnce()
	expect(exhausted.retry).toHaveBeenCalledWith({ delaySeconds: 90 })
	expect(exhausted.ack).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_retry_exhausted',
		expect.objectContaining({
			lane: 'retention',
			scheduledTime,
			attempts: scheduledDispatchMaxRetries + 1,
			outcome: 'd1_lock_contention',
		}),
	)
	expect(captureMessage).toHaveBeenCalledWith(
		'scheduled_lane_retry_exhausted lane=retention',
	)

	expect(host).toHaveBeenCalledTimes(4)
	for (const call of host.mock.calls) {
		expect(call[0]).toEqual(retention)
	}

	const laterLock = queueMessage({
		id: 'later-lock',
		body: retention,
		attempts: 2,
	})
	host.mockResolvedValueOnce('d1_lock_contention')
	await handleScheduledDispatchQueue(
		{ messages: [laterLock] } as unknown as MessageBatch<unknown>,
		env,
	)
	expect(laterLock.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(laterLock.ack).not.toHaveBeenCalled()
})

test('inline fallback keeps scheduledTime and does not invent extra lane retries', async () => {
	silenceExpectedConsoleErrors([
		'scheduled_lane_dispatch_failed lane=oauth_purge_expired',
		'scheduled_lane_inline_d1_lock_contention',
	])
	const host = vi.fn().mockResolvedValue('d1_lock_contention')
	const failingSend = vi.fn(async (body: ScheduledLaneMessage) => {
		if (body.lane === 'oauth_purge_expired') {
			throw new Error('queue unavailable')
		}
	})
	const env = createEnv({
		HOST: { runScheduledLane: host },
		SCHEDULED_DISPATCH_QUEUE: { send: failingSend },
	})
	const fallbackTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatchScheduledLanes({
		controller: {
			scheduledTime: fallbackTime,
			cron: '*/5 * * * *',
		} as ScheduledController,
		env,
	})
	expect(host).toHaveBeenCalledTimes(1)
	expect(host).toHaveBeenCalledWith({
		lane: 'oauth_purge_expired',
		scheduledTime: fallbackTime,
		cron: '*/5 * * * *',
	})
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_inline_d1_lock_contention',
		expect.objectContaining({
			lane: 'oauth_purge_expired',
			scheduledTime: fallbackTime,
		}),
	)
})

test('production scheduled-dispatch consumer retry bound matches the shared contract', async () => {
	const wrangler = await readFile(
		new URL('../wrangler.jsonc', import.meta.url),
		'utf8',
	)
	const consumer = wrangler.match(
		/"queue": "kody-scheduled-dispatch",[\s\S]*?"max_retries": (\d+),[\s\S]*?"dead_letter_queue": "kody-scheduled-dispatch-dlq"/,
	)
	expect(consumer?.[1]).toBe(String(scheduledDispatchMaxRetries))
})
