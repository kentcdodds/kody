import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	getScheduledLaneCadence,
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
