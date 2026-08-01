import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const syncJobManagerAlarm = vi.fn(async () => ({
	ok: true as const,
	userId: 'user-a',
	nextRunAt: null,
}))
const withAccountWriteLease = vi.fn(
	async (input: { write: () => Promise<unknown> }) => input.write(),
)
const listSilentlyOverdueJobRowsPage = vi.fn()
const listStuckSkippedJobRowsPage = vi.fn()
const advanceStuckSkippedJobNextRunAt = vi.fn()
const captureMessage = vi.fn()

vi.mock('./manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		syncJobManagerAlarm(...args),
}))

vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: (...args: Array<unknown>) =>
		withAccountWriteLease(...(args as [never])),
}))

vi.mock('./repo.ts', () => ({
	listSilentlyOverdueJobRowsPage: (...args: Array<unknown>) =>
		listSilentlyOverdueJobRowsPage(...args),
	listStuckSkippedJobRowsPage: (...args: Array<unknown>) =>
		listStuckSkippedJobRowsPage(...args),
	advanceStuckSkippedJobNextRunAt: (...args: Array<unknown>) =>
		advanceStuckSkippedJobNextRunAt(...args),
}))

vi.mock('@sentry/cloudflare', () => ({
	withScope: (
		fn: (scope: { setTag: () => void; setContext: () => void }) => void,
	) => fn({ setTag: () => {}, setContext: () => {} }),
	captureMessage: (...args: Array<unknown>) => captureMessage(...args),
}))

const {
	jobScheduleWatchdogAlertKvKey,
	runJobScheduleWatchdogTick,
	shouldRunJobScheduleWatchdogCron,
} = await import('./job-schedule-watchdog.ts')

function jobRow(input: {
	id: string
	userId: string
	name: string
	nextRunAt: string
	schedule?:
		| { type: 'interval'; every: string }
		| { type: 'once'; runAt: string }
	lastCompletedScheduledFor?: string | null
}) {
	const schedule = input.schedule ?? { type: 'interval' as const, every: '1m' }
	return {
		id: input.id,
		user_id: input.userId,
		name: input.name,
		next_run_at: input.nextRunAt,
		last_run_at: null,
		last_completed_scheduled_for: input.lastCompletedScheduledFor ?? null,
		record: {
			version: 1 as const,
			id: input.id,
			userId: input.userId,
			name: input.name,
			sourceId: `source-${input.id}`,
			publishedCommit: null,
			storageId: `storage-${input.id}`,
			schedule,
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			expiresAt: null,
			createdAt: '2026-07-16T15:00:00.000Z',
			updatedAt: '2026-07-23T17:00:00.000Z',
			nextRunAt: input.nextRunAt,
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
	}
}

test('job schedule watchdog re-arms alarms for overdue users, repairs stuck fences, isolates sync failures, and cools Sentry alerts', async () => {
	expect(
		shouldRunJobScheduleWatchdogCron(new Date('2026-07-23T17:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunJobScheduleWatchdogCron(new Date('2026-07-23T17:05:00.000Z')),
	).toBe(false)
	expect(
		shouldRunJobScheduleWatchdogCron(new Date('2026-07-23T17:15:00.000Z')),
	).toBe(true)

	const now = new Date('2026-07-23T17:30:00.000Z')
	const overdue = jobRow({
		id: 'job-overdue',
		userId: 'user-a',
		name: 'poller-a',
		nextRunAt: '2026-07-23T17:20:00.000Z',
	})
	const stuck = jobRow({
		id: 'job-stuck',
		userId: 'user-b',
		name: 'poller-b',
		nextRunAt: '2026-07-23T17:21:00.000Z',
		lastCompletedScheduledFor: '2026-07-23T17:21:00.000Z',
	})

	listSilentlyOverdueJobRowsPage.mockResolvedValueOnce([overdue])
	listStuckSkippedJobRowsPage.mockResolvedValueOnce([stuck])
	advanceStuckSkippedJobNextRunAt.mockResolvedValueOnce(true)
	syncJobManagerAlarm
		.mockRejectedValueOnce(new Error('do unavailable'))
		.mockResolvedValueOnce({
			ok: true as const,
			userId: 'user-b',
			nextRunAt: null,
		})
	consoleWarn.mockImplementation(() => {})

	const kvStore = new Map<string, string>()
	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {
			async get(key: string) {
				return kvStore.get(key) ?? null
			},
			async put(key: string, value: string) {
				kvStore.set(key, value)
			},
		} as unknown as KVNamespace,
	}

	const first = await runJobScheduleWatchdogTick({ env, now })
	expect(first).toEqual({
		overdueJobCount: 1,
		stuckSkippedJobCount: 1,
		repairedStuckJobCount: 1,
		usersSynced: 1,
		usersFailedSync: 1,
		usersSkippedCap: 0,
		scanTruncated: false,
		alerted: true,
	})
	expect(syncJobManagerAlarm).toHaveBeenCalledTimes(2)
	expect(syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-a',
	})
	expect(syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-b',
	})
	expect(advanceStuckSkippedJobNextRunAt).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-b',
			jobId: 'job-stuck',
			nextRunAt: '2026-07-23T17:31:00.000Z',
		}),
	)
	expect(captureMessage).toHaveBeenCalledTimes(1)
	expect(kvStore.get(jobScheduleWatchdogAlertKvKey)).toBe(String(now.getTime()))
	expect(consoleWarn).toHaveBeenCalledWith(
		'job-schedule-watchdog-sync-failed',
		expect.objectContaining({ userId: 'user-a' }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'job-schedule-watchdog-overdue',
		expect.objectContaining({
			overdueJobCount: 1,
			stuckSkippedJobCount: 1,
			usersSynced: 1,
			usersFailedSync: 1,
			overdueSample: [
				expect.objectContaining({
					jobId: 'job-overdue',
					userId: 'user-a',
				}),
			],
		}),
	)
	const overduePayload = consoleWarn.mock.calls.find(
		(call) => call[0] === 'job-schedule-watchdog-overdue',
	)?.[1] as {
		overdueSample: Array<{ name?: string; lastRunAt?: string }>
	}
	expect(overduePayload.overdueSample[0]).not.toHaveProperty('name')
	expect(overduePayload.overdueSample[0]).not.toHaveProperty('lastRunAt')

	listSilentlyOverdueJobRowsPage.mockResolvedValueOnce([overdue])
	listStuckSkippedJobRowsPage.mockResolvedValueOnce([])
	advanceStuckSkippedJobNextRunAt.mockClear()
	syncJobManagerAlarm.mockReset()
	syncJobManagerAlarm.mockResolvedValue({
		ok: true as const,
		userId: 'user-a',
		nextRunAt: null,
	})
	captureMessage.mockClear()
	consoleWarn.mockClear()
	consoleWarn.mockImplementation(() => {})

	const second = await runJobScheduleWatchdogTick({
		env,
		now: new Date(now.getTime() + 15 * 60_000),
	})
	expect(second.alerted).toBe(false)
	expect(second.usersSynced).toBe(1)
	expect(second.usersFailedSync).toBe(0)
	expect(captureMessage).not.toHaveBeenCalled()
	expect(syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-a',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'job-schedule-watchdog-overdue',
		expect.objectContaining({ overdueJobCount: 1 }),
	)
})
