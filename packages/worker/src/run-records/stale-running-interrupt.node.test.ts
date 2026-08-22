import { expect, test } from 'vitest'
import {
	runErrorTriageForPlatformInterrupt,
	runRecordPlatformInterruptedErrorMessage,
	runRecordPlatformInterruptedErrorName,
	type RunRecordContext,
} from './types.ts'

function platformInterruptTriage(overrides: Partial<RunRecordContext>) {
	return runErrorTriageForPlatformInterrupt({
		surface: 'job',
		idempotencyKey: null,
		...overrides,
	})
}

test('platform interrupt has a stable error contract and only auto-ignores retryable deliveries', () => {
	expect(runRecordPlatformInterruptedErrorName).toBe('platform_interrupted')
	expect(runRecordPlatformInterruptedErrorMessage).toBe(
		'The platform interrupted this run before completion; outcome unknown.',
	)

	expect(
		platformInterruptTriage({
			surface: 'job',
			idempotencyKey: 'scheduled-job:job-1:2026-08-21T00:00:00.000Z',
		}),
	).toBe('ignored')
	expect(
		platformInterruptTriage({
			surface: 'subscription',
			idempotencyKey: 'delivery-123',
		}),
	).toBe('ignored')

	expect(
		platformInterruptTriage({
			surface: 'job',
			idempotencyKey: 'manual-retry-key',
		}),
	).toBeNull()
	expect(
		platformInterruptTriage({
			surface: 'subscription',
			idempotencyKey: ' ',
		}),
	).toBeNull()
	expect(
		platformInterruptTriage({
			surface: 'execute',
			idempotencyKey: 'caller-recovery-key',
		}),
	).toBeNull()
})
