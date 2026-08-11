import { beforeEach, expect, test, vi } from 'vitest'
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

beforeEach(() => {
	vi.mocked(runJobScheduleWatchdogTick).mockClear()
})

test('platform lanes are forwarded to the main worker via HOST', async () => {
	const env = createEnv()
	const result = await runScheduledLaneWithFailureIsolation({
		env,
		message: message('oauth_purge_expired'),
	})
	expect(result).toBe('completed')
	expect(env.HOST.runScheduledLane).toHaveBeenCalledWith(
		message('oauth_purge_expired'),
	)
	expect(runJobScheduleWatchdogTick).not.toHaveBeenCalled()
})

test('job_schedule_watchdog runs locally in the jobs worker', async () => {
	const env = createEnv()
	const result = await runScheduledLaneWithFailureIsolation({
		env,
		message: message('job_schedule_watchdog'),
	})
	expect(result).toBe('completed')
	expect(runJobScheduleWatchdogTick).toHaveBeenCalledOnce()
	expect(env.HOST.runScheduledLane).not.toHaveBeenCalled()
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

test('cron dispatch enqueues one message per cadence lane', async () => {
	const send = vi.fn().mockResolvedValue(undefined)
	const env = createEnv({ SCHEDULED_DISPATCH_QUEUE: { send } })
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	await dispatchScheduledLanes({
		controller: { scheduledTime, cron: '*/5 * * * *' } as ScheduledController,
		env,
	})
	const lanes = getScheduledLaneCadence(new Date(scheduledTime))
	expect(send).toHaveBeenCalledTimes(lanes.length)
	expect(send).toHaveBeenCalledWith({
		lane: 'retention',
		scheduledTime,
		cron: '*/5 * * * *',
	})
	expect(env.HOST.runScheduledLane).not.toHaveBeenCalled()
})

test('cron dispatch falls back to direct execution without a queue', async () => {
	const env = createEnv()
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatchScheduledLanes({
		controller: { scheduledTime, cron: '*/5 * * * *' } as ScheduledController,
		env,
	})
	const lanes = getScheduledLaneCadence(new Date(scheduledTime))
	expect(env.HOST.runScheduledLane).toHaveBeenCalledTimes(lanes.length)
})

test('individual queue-send failures fall back to direct execution', async () => {
	consoleError.mockImplementation(() => {})
	const send = vi.fn(async (body: ScheduledLaneMessage) => {
		if (body.lane === 'oauth_purge_expired') {
			throw new Error('queue unavailable')
		}
	})
	const env = createEnv({ SCHEDULED_DISPATCH_QUEUE: { send } })
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatchScheduledLanes({
		controller: { scheduledTime, cron: '*/5 * * * *' } as ScheduledController,
		env,
	})
	expect(env.HOST.runScheduledLane).toHaveBeenCalledTimes(1)
	expect(env.HOST.runScheduledLane).toHaveBeenCalledWith({
		lane: 'oauth_purge_expired',
		scheduledTime,
		cron: '*/5 * * * *',
	})
})

test('queue consumer acknowledges invalid messages without running lanes', async () => {
	consoleError.mockImplementation(() => {})
	const env = createEnv()
	const invalidAck = vi.fn()
	const validAck = vi.fn()
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
