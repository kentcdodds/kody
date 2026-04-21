import { afterEach, expect, test, vi } from 'vitest'
import {
	logJobSchedulerError,
	summarizeSchedulerJobOutcomes,
} from './scheduler-logging.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

test('summarizeSchedulerJobOutcomes keeps full fields while limiting count', () => {
	const longMessage = 'x'.repeat(1300)

	const result = summarizeSchedulerJobOutcomes([
		{
			jobId: 'job-123',
			scheduleType: 'once',
			outcome: 'failure',
			nextRunAt: null,
			deleted: true,
			error: longMessage,
			rescheduleError: longMessage,
		},
	])

	expect(result).toEqual({
		jobOutcomes: [
			{
				jobId: 'job-123',
				scheduleType: 'once',
				outcome: 'failure',
				nextRunAt: null,
				deleted: true,
				error: longMessage,
				rescheduleError: longMessage,
			},
		],
	})
})

test('logJobSchedulerError truncates top-level errorMessage before logging', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

	logJobSchedulerError({
		event: 'sync_alarm_failed',
		userId: 'user-123',
		errorName: 'Error',
		errorMessage: 'y'.repeat(1205),
	})

	expect(errorSpy).toHaveBeenCalledTimes(1)
	const [tagArg, jsonArg] = errorSpy.mock.calls[0] ?? []
	expect(tagArg).toBe('job-scheduler')
	expect(typeof jsonArg).toBe('string')
	const payload = JSON.parse(jsonArg as string) as Record<string, unknown>
	expect(payload.errorMessage).toBe(
		`${'y'.repeat(1000)}...[truncated 205 chars]`,
	)
})

test('logJobSchedulerError truncates per-job error fields before logging', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

	logJobSchedulerError({
		event: 'alarm_processed_due_jobs',
		userId: 'user-123',
		jobOutcomes: [
			{
				jobId: 'job-123',
				scheduleType: 'once',
				outcome: 'failure',
				nextRunAt: null,
				deleted: true,
				error: 'z'.repeat(1100),
				rescheduleError: 'w'.repeat(1010),
			},
		],
	})

	expect(errorSpy).toHaveBeenCalledTimes(1)
	const [, jsonArg] = errorSpy.mock.calls[0] ?? []
	const payload = JSON.parse(jsonArg as string) as {
		jobOutcomes: Array<Record<string, unknown>>
	}
	expect(payload.jobOutcomes).toEqual([
		{
			jobId: 'job-123',
			scheduleType: 'once',
			outcome: 'failure',
			nextRunAt: null,
			deleted: true,
			error: `${'z'.repeat(1000)}...[truncated 100 chars]`,
			rescheduleError: `${'w'.repeat(1000)}...[truncated 10 chars]`,
		},
	])
})

test('logJobSchedulerError always emits a timestamp when input timestamp is undefined', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

	logJobSchedulerError({
		event: 'sync_alarm_failed',
		userId: 'user-123',
		errorName: 'Error',
		errorMessage: 'boom',
		timestamp: undefined,
	})

	expect(errorSpy).toHaveBeenCalledTimes(1)
	const [, jsonArg] = errorSpy.mock.calls[0] ?? []
	const payload = JSON.parse(jsonArg as string) as Record<string, unknown>
	expect(typeof payload.timestamp).toBe('string')
	expect(payload.timestamp).not.toBe('')
})
