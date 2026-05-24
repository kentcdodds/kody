import { expect, test, vi } from 'vitest'
import {
	logJobSchedulerError,
	summarizeSchedulerJobOutcomes,
} from './scheduler-logging.ts'

test('logJobSchedulerError truncates oversized fields, caps outcome count, and always emits a timestamp', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const manyOutcomes = Array.from({ length: 11 }, (_, index) => ({
			jobId: `job-${index}`,
			scheduleType: 'once' as const,
			outcome: 'success' as const,
			nextRunAt: null,
			deleted: false,
		}))
		expect(summarizeSchedulerJobOutcomes(manyOutcomes)).toEqual({
			jobOutcomes: manyOutcomes.slice(0, 10),
			truncatedJobOutcomeCount: 1,
		})

		logJobSchedulerError({
			event: 'sync_alarm_failed',
			userId: 'user-123',
			errorName: 'Error',
			errorMessage: 'y'.repeat(1205),
		})

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

		logJobSchedulerError({
			event: 'sync_alarm_failed',
			userId: 'user-123',
			errorName: 'Error',
			errorMessage: 'boom',
			timestamp: undefined,
		})

		expect(errorSpy).toHaveBeenCalledTimes(3)
		const topLevelPayload = JSON.parse(
			(errorSpy.mock.calls[0] ?? [])[1] as string,
		) as Record<string, unknown>
		expect((errorSpy.mock.calls[0] ?? [])[0]).toBe('job-scheduler')
		expect(topLevelPayload.errorMessage).toBe(
			`${'y'.repeat(1000)}...[truncated 205 chars]`,
		)

		const jobOutcomePayload = JSON.parse(
			(errorSpy.mock.calls[1] ?? [])[1] as string,
		) as {
			jobOutcomes: Array<Record<string, unknown>>
		}
		expect(jobOutcomePayload.jobOutcomes).toEqual([
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

		const timestampPayload = JSON.parse(
			(errorSpy.mock.calls[2] ?? [])[1] as string,
		) as Record<string, unknown>
		expect(typeof timestampPayload.timestamp).toBe('string')
		expect(timestampPayload.timestamp).not.toBe('')
	} finally {
		errorSpy.mockRestore()
	}
})
