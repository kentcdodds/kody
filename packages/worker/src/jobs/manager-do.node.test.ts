import type * as SchedulerLoggingType from './scheduler-logging.ts'
import { expect, test, vi } from 'vitest'
import { resolveJobManagerAlarmState } from './manager-state.ts'

const mockModule = vi.hoisted(() => ({
	getNextRunnableJob: vi.fn(),
	runDueJobsForUser: vi.fn(),
	runJobNow: vi.fn(),
	buildSentryOptions: vi.fn(),
	logJobSchedulerEvent: vi.fn(),
	logJobSchedulerError: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected readonly ctx: DurableObjectState
		protected readonly env: Env

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx
			this.env = env
		}
	},
}))

vi.mock('./service.ts', () => ({
	getNextRunnableJob: (...args: Array<unknown>) =>
		mockModule.getNextRunnableJob(...args),
	runDueJobsForUser: (...args: Array<unknown>) =>
		mockModule.runDueJobsForUser(...args),
	runJobNow: (...args: Array<unknown>) => mockModule.runJobNow(...args),
}))

vi.mock('#worker/sentry-options.ts', () => ({
	buildSentryOptions: (...args: Array<unknown>) =>
		mockModule.buildSentryOptions(...args),
}))

vi.mock('./scheduler-logging.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof SchedulerLoggingType>()
	return {
		...actual,
		logJobSchedulerEvent: (...args: Array<unknown>) =>
			mockModule.logJobSchedulerEvent(...args),
		logJobSchedulerError: (...args: Array<unknown>) =>
			mockModule.logJobSchedulerError(...args),
	}
})

const { JobManagerBase } = await import('./manager-do.ts')

function resetMocks() {
	mockModule.getNextRunnableJob.mockReset()
	mockModule.runDueJobsForUser.mockReset()
	mockModule.runJobNow.mockReset()
	mockModule.buildSentryOptions.mockReset()
	mockModule.logJobSchedulerEvent.mockReset()
	mockModule.logJobSchedulerError.mockReset()
}

function createState({
	userId = 'user-123',
	currentAlarmAt = null,
}: {
	userId?: string
	currentAlarmAt?: number | null
} = {}) {
	const persistedEntries = new Map<string, unknown>()
	if (userId !== undefined) {
		persistedEntries.set('user-id', userId)
	}
	let alarmAt = currentAlarmAt

	return {
		state: {
			storage: {
				get: vi.fn(async (key: string) => persistedEntries.get(key)),
				put: vi.fn(async (key: string, value: unknown) => {
					persistedEntries.set(key, value)
				}),
				getAlarm: vi.fn(async () => alarmAt),
				setAlarm: vi.fn(async (value: Date | number) => {
					alarmAt = value instanceof Date ? value.valueOf() : Number(value)
				}),
				deleteAlarm: vi.fn(async () => {
					alarmAt = null
				}),
			},
		} as unknown as DurableObjectState,
		persistedEntries,
		getAlarmAt() {
			return alarmAt
		},
	}
}

test('resolveJobManagerAlarmState treats equivalent UTC formats as in sync', () => {
	expect(
		resolveJobManagerAlarmState({
			alarmTimestamp: Date.parse('2026-04-20T18:30:00.000Z'),
			nextRunnableRunAt: '2026-04-20T18:30:00Z',
		}),
	).toEqual({
		alarmScheduledFor: '2026-04-20T18:30:00.000Z',
		alarmInSync: true,
		status: 'armed',
	})
})

test('resolveJobManagerAlarmState marks mismatched alarm times as out of sync', () => {
	expect(
		resolveJobManagerAlarmState({
			alarmTimestamp: Date.parse('2026-04-20T19:00:00.000Z'),
			nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		}),
	).toEqual({
		alarmScheduledFor: '2026-04-20T19:00:00.000Z',
		alarmInSync: false,
		status: 'out_of_sync',
	})
})

test('resolveJobManagerAlarmState reports idle when no alarm or next runnable job exists', () => {
	expect(
		resolveJobManagerAlarmState({
			alarmTimestamp: null,
			nextRunnableRunAt: null,
		}),
	).toEqual({
		alarmScheduledFor: null,
		alarmInSync: true,
		status: 'idle',
	})
})

test('syncAlarm logs when it arms a new alarm for the next runnable job', async () => {
	resetMocks()
	const nextRunAt = '2026-04-20T18:30:00.000Z'
	mockModule.getNextRunnableJob.mockResolvedValue({
		id: 'job-123',
		nextRunAt,
	})
	const { state, persistedEntries, getAlarmAt } = createState({
		currentAlarmAt: Date.parse('2026-04-20T18:00:00.000Z'),
	})
	const manager = new JobManagerBase(state, {} as Env)

	await expect(manager.syncAlarm({ userId: 'user-123' })).resolves.toEqual({
		ok: true,
		userId: 'user-123',
		nextRunAt,
	})

	expect(persistedEntries.get('user-id')).toBe('user-123')
	expect(getAlarmAt()).toBe(Date.parse(nextRunAt))
	expect(mockModule.logJobSchedulerEvent).toHaveBeenCalledWith({
		event: 'sync_alarm',
		userId: 'user-123',
		currentAlarmAt: '2026-04-20T18:00:00.000Z',
		nextJobId: 'job-123',
		nextRunAt,
		reason: 'alarm_armed',
	})
	expect(mockModule.logJobSchedulerError).not.toHaveBeenCalled()
})

test('syncAlarm logs when no runnable job is found and clears the alarm', async () => {
	resetMocks()
	mockModule.getNextRunnableJob.mockResolvedValue(null)
	const { state, getAlarmAt } = createState({
		currentAlarmAt: Date.parse('2026-04-20T18:00:00.000Z'),
	})
	const manager = new JobManagerBase(state, {} as Env)

	await expect(manager.syncAlarm({ userId: 'user-123' })).resolves.toEqual({
		ok: true,
		userId: 'user-123',
		nextRunAt: null,
	})

	expect(getAlarmAt()).toBeNull()
	expect(mockModule.logJobSchedulerEvent).toHaveBeenCalledWith({
		event: 'sync_alarm',
		userId: 'user-123',
		currentAlarmAt: '2026-04-20T18:00:00.000Z',
		nextJobId: null,
		nextRunAt: null,
		reason: 'no_runnable_job',
	})
})

test('alarm logs firing, due-job outcomes, and resyncs the next alarm', async () => {
	resetMocks()
	mockModule.runDueJobsForUser.mockResolvedValue({
		dueJobCount: 2,
		successCount: 1,
		errorCount: 1,
		jobOutcomes: [
			{
				jobId: 'job-success',
				scheduleType: 'once',
				outcome: 'success',
				nextRunAt: null,
				deleted: true,
			},
			{
				jobId: 'job-failure',
				scheduleType: 'interval',
				outcome: 'failure',
				nextRunAt: '2026-04-20T19:00:00.000Z',
				deleted: false,
				error: 'boom',
			},
		],
	})
	mockModule.getNextRunnableJob.mockResolvedValue({
		id: 'job-next',
		nextRunAt: '2026-04-20T19:00:00.000Z',
	})
	const { state } = createState()
	const manager = new JobManagerBase(state, {} as Env)

	await expect(
		manager.alarm({
			retryCount: 2,
			isRetry: true,
		}),
	).resolves.toBeUndefined()

	expect(mockModule.runDueJobsForUser).toHaveBeenCalledWith({
		env: {} as Env,
		userId: 'user-123',
	})
	expect(mockModule.logJobSchedulerEvent).toHaveBeenNthCalledWith(1, {
		event: 'alarm_fired',
		userId: 'user-123',
		retryCount: 2,
		isRetry: true,
	})
	expect(mockModule.logJobSchedulerEvent).toHaveBeenNthCalledWith(2, {
		event: 'run_due_jobs_completed',
		userId: 'user-123',
		dueJobCount: 2,
		successCount: 1,
		errorCount: 1,
		reason: 'processed_due_jobs',
		jobOutcomes: [
			{
				jobId: 'job-success',
				scheduleType: 'once',
				outcome: 'success',
				nextRunAt: null,
				deleted: true,
			},
			{
				jobId: 'job-failure',
				scheduleType: 'interval',
				outcome: 'failure',
				nextRunAt: '2026-04-20T19:00:00.000Z',
				deleted: false,
				error: 'boom',
			},
		],
	})
	expect(mockModule.logJobSchedulerEvent).toHaveBeenNthCalledWith(3, {
		event: 'sync_alarm',
		userId: 'user-123',
		currentAlarmAt: null,
		nextJobId: 'job-next',
		nextRunAt: '2026-04-20T19:00:00.000Z',
		reason: 'alarm_armed',
	})
	expect(mockModule.logJobSchedulerError).not.toHaveBeenCalled()
})

test('syncAlarm logs source-tagged errors when getNextRunnableJob fails', async () => {
	resetMocks()
	mockModule.getNextRunnableJob.mockRejectedValue(
		new Error('next job lookup failed'),
	)
	const { state } = createState()
	const manager = new JobManagerBase(state, {} as Env)

	await expect(
		manager.syncAlarm({ userId: 'user-123', source: 'alarm' }),
	).rejects.toThrow('next job lookup failed')

	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'sync_alarm_failed',
		userId: 'user-123',
		source: 'alarm',
		errorName: 'Error',
		errorMessage: 'next job lookup failed',
	})
})

test('syncAlarm logs source-tagged errors when deleteAlarm fails', async () => {
	resetMocks()
	mockModule.getNextRunnableJob.mockResolvedValue(null)
	const { state } = createState()
	const deleteAlarm = vi.mocked(
		state.storage.deleteAlarm as unknown as (
			...args: Array<unknown>
		) => Promise<void>,
	)
	deleteAlarm.mockRejectedValueOnce(new Error('delete alarm failed'))
	const manager = new JobManagerBase(state, {} as Env)

	await expect(
		manager.syncAlarm({ userId: 'user-123', source: 'rpc' }),
	).rejects.toThrow('delete alarm failed')

	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'sync_alarm_failed',
		userId: 'user-123',
		source: 'rpc',
		errorName: 'Error',
		errorMessage: 'delete alarm failed',
	})
})

test('syncAlarm logs source-tagged errors when setAlarm fails', async () => {
	resetMocks()
	mockModule.getNextRunnableJob.mockResolvedValue({
		id: 'job-123',
		nextRunAt: '2026-04-20T18:30:00.000Z',
	})
	const { state } = createState()
	const setAlarm = vi.mocked(
		state.storage.setAlarm as unknown as (
			...args: Array<unknown>
		) => Promise<void>,
	)
	setAlarm.mockRejectedValueOnce(new Error('set alarm failed'))
	const manager = new JobManagerBase(state, {} as Env)

	await expect(
		manager.syncAlarm({ userId: 'user-123', source: 'run_now' }),
	).rejects.toThrow('set alarm failed')

	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'sync_alarm_failed',
		userId: 'user-123',
		source: 'run_now',
		errorName: 'Error',
		errorMessage: 'set alarm failed',
	})
})

test('alarm logs missing_user_id when no user id was persisted', async () => {
	resetMocks()
	const { state } = createState()
	vi.mocked(
		state.storage.get as unknown as (
			key: string,
		) => Promise<string | undefined>,
	).mockResolvedValueOnce(undefined)
	const manager = new JobManagerBase(state, {} as Env)

	await expect(manager.alarm()).resolves.toBeUndefined()

	expect(mockModule.logJobSchedulerEvent).toHaveBeenCalledWith({
		event: 'alarm_fired',
		reason: 'missing_user_id',
		retryCount: undefined,
		isRetry: undefined,
	})
})

test('alarm logs run_due_jobs failure details', async () => {
	resetMocks()
	mockModule.runDueJobsForUser.mockRejectedValue(
		new Error('run due jobs failed'),
	)
	const { state } = createState()
	const manager = new JobManagerBase(state, {} as Env)

	await expect(manager.alarm()).rejects.toThrow('run due jobs failed')

	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'alarm_run_due_jobs_failed',
		userId: 'user-123',
		retryCount: undefined,
		isRetry: undefined,
		errorName: 'Error',
		errorMessage: 'run due jobs failed',
	})
})

test('alarm logs resync failure details after due jobs run', async () => {
	resetMocks()
	mockModule.runDueJobsForUser.mockResolvedValue({
		dueJobCount: 0,
		successCount: 0,
		errorCount: 0,
		jobOutcomes: [],
	})
	const { state } = createState()
	const manager = new JobManagerBase(state, {} as Env)
	const syncAlarmSpy = vi
		.spyOn(manager, 'syncAlarm')
		.mockRejectedValueOnce(new Error('resync failed'))

	await expect(manager.alarm()).rejects.toThrow('resync failed')

	expect(syncAlarmSpy).toHaveBeenCalledWith({
		userId: 'user-123',
		source: 'alarm',
	})
	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'alarm_resync_failed',
		userId: 'user-123',
		retryCount: undefined,
		isRetry: undefined,
		errorName: 'Error',
		errorMessage: 'resync failed',
	})
})
