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

test('resolveJobManagerAlarmState covers armed, out-of-sync, and idle states', () => {
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

test('syncAlarm arms, clears, and logs scheduler state transitions', async () => {
	resetMocks()
	const nextRunAt = '2026-04-20T18:30:00.000Z'
	mockModule.getNextRunnableJob.mockResolvedValue({
		id: 'job-123',
		nextRunAt,
	})
	const armedState = createState({
		currentAlarmAt: Date.parse('2026-04-20T18:00:00.000Z'),
	})
	const armedManager = new JobManagerBase(armedState.state, {} as Env)

	await expect(armedManager.syncAlarm({ userId: 'user-123' })).resolves.toEqual(
		{
			ok: true,
			userId: 'user-123',
			nextRunAt,
		},
	)

	expect(armedState.persistedEntries.get('user-id')).toBe('user-123')
	expect(armedState.getAlarmAt()).toBe(Date.parse(nextRunAt))
	expect(mockModule.logJobSchedulerEvent).toHaveBeenCalledWith({
		event: 'sync_alarm',
		userId: 'user-123',
		currentAlarmAt: '2026-04-20T18:00:00.000Z',
		nextJobId: 'job-123',
		nextRunAt,
		reason: 'alarm_armed',
	})
	expect(mockModule.logJobSchedulerError).not.toHaveBeenCalled()

	resetMocks()
	mockModule.getNextRunnableJob.mockResolvedValue(null)
	const clearedState = createState({
		currentAlarmAt: Date.parse('2026-04-20T18:00:00.000Z'),
	})
	const clearedManager = new JobManagerBase(clearedState.state, {} as Env)

	await expect(
		clearedManager.syncAlarm({ userId: 'user-123' }),
	).resolves.toEqual({
		ok: true,
		userId: 'user-123',
		nextRunAt: null,
	})

	expect(clearedState.getAlarmAt()).toBeNull()
	expect(mockModule.logJobSchedulerEvent).toHaveBeenCalledWith({
		event: 'sync_alarm',
		userId: 'user-123',
		currentAlarmAt: '2026-04-20T18:00:00.000Z',
		nextJobId: null,
		nextRunAt: null,
		reason: 'no_runnable_job',
	})

	resetMocks()
	mockModule.getNextRunnableJob.mockRejectedValue(
		new Error('next job lookup failed'),
	)
	const lookupFailureState = createState()
	const lookupFailureManager = new JobManagerBase(
		lookupFailureState.state,
		{} as Env,
	)

	await expect(
		lookupFailureManager.syncAlarm({ userId: 'user-123', source: 'alarm' }),
	).rejects.toThrow('next job lookup failed')
	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'sync_alarm_failed',
		userId: 'user-123',
		source: 'alarm',
		errorName: 'Error',
		errorMessage: 'next job lookup failed',
	})
})

test('exportUser returns the scheduler state for account export', async () => {
	resetMocks()
	const nextRunAt = '2026-04-20T18:30:00.000Z'
	mockModule.getNextRunnableJob.mockResolvedValue({
		id: 'job-123',
		nextRunAt,
	})
	const state = createState({
		currentAlarmAt: Date.parse(nextRunAt),
	})
	const manager = new JobManagerBase(state.state, {} as Env)

	await expect(manager.exportUser({ userId: 'user-123' })).resolves.toEqual({
		bindingAvailable: true,
		status: 'armed',
		storedUserId: 'user-123',
		alarmScheduledFor: nextRunAt,
		nextRunnableJobId: 'job-123',
		nextRunnableRunAt: nextRunAt,
		alarmInSync: true,
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

	resetMocks()
	const missingUserState = createState()
	vi.mocked(
		missingUserState.state.storage.get as unknown as (
			key: string,
		) => Promise<string | undefined>,
	).mockResolvedValueOnce(undefined)
	const missingUserManager = new JobManagerBase(
		missingUserState.state,
		{} as Env,
	)

	await expect(missingUserManager.alarm()).resolves.toBeUndefined()
	expect(mockModule.logJobSchedulerEvent).toHaveBeenCalledWith({
		event: 'alarm_fired',
		reason: 'missing_user_id',
		retryCount: undefined,
		isRetry: undefined,
	})

	resetMocks()
	mockModule.runDueJobsForUser.mockRejectedValue(
		new Error('run due jobs failed'),
	)
	const runFailureState = createState()
	const runFailureManager = new JobManagerBase(runFailureState.state, {} as Env)

	await expect(runFailureManager.alarm()).rejects.toThrow('run due jobs failed')
	expect(mockModule.logJobSchedulerError).toHaveBeenCalledWith({
		event: 'alarm_run_due_jobs_failed',
		userId: 'user-123',
		retryCount: undefined,
		isRetry: undefined,
		errorName: 'Error',
		errorMessage: 'run due jobs failed',
	})
})
