import { expect, test, vi } from 'vitest'

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
	const actual = await importOriginal<typeof import('./scheduler-logging.ts')>()
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
	userId?: string | null
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
		reason: 'alarm-armed',
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
		reason: 'no-runnable-job',
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
		event: 'alarm_processed_due_jobs',
		userId: 'user-123',
		dueJobCount: 2,
		successCount: 1,
		errorCount: 1,
		reason: 'processed-due-jobs',
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
		reason: 'alarm-armed',
	})
	expect(mockModule.logJobSchedulerError).not.toHaveBeenCalled()
})
