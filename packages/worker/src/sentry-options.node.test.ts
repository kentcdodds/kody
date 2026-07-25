import { expect, test } from 'vitest'
import {
	executorSandboxTimeoutMessage,
	filterExecutorSandboxTimeoutSentryEvent,
	filterRetryableD1LockSentryEvent,
	filterSentryEvent,
	filterUserModuleBundlerFailureSentryEvent,
} from './sentry-options.ts'

test('filterRetryableD1LockSentryEvent drops transient D1 lock contention and keeps other errors', () => {
	expect(
		filterRetryableD1LockSentryEvent({
			exception: {
				values: [
					{
						value: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterRetryableD1LockSentryEvent({
			exception: {
				values: [
					{
						value: 'Currently processing a long-running export.',
					},
					{
						value: 'D1_ERROR: Currently processing a long-running export.',
					},
				],
			},
		}),
	).toBeNull()

	const unrelatedEvent = {
		exception: {
			values: [{ value: 'D1_ERROR: syntax error near INSERTZ' }],
		},
	}
	expect(filterRetryableD1LockSentryEvent(unrelatedEvent)).toBe(unrelatedEvent)
})

test('filterUserModuleBundlerFailureSentryEvent drops esbuild failures in caller modules', () => {
	const userModuleBuildFailure = {
		exception: {
			values: [
				{
					value:
						'Build failed with 1 error:\nvirtual:.__kody_root__/entry.ts:11:49: ERROR: Unexpected "^"',
				},
			],
		},
	}
	expect(
		filterUserModuleBundlerFailureSentryEvent(userModuleBuildFailure),
	).toBeNull()
	expect(filterSentryEvent(userModuleBuildFailure)).toBeNull()

	const userModuleMessageFailure = {
		message:
			'Build failed with 1 error:\nvirtual:.__kody_root__/entry.ts:11:49: ERROR: Unexpected "^"',
	}
	expect(
		filterUserModuleBundlerFailureSentryEvent(userModuleMessageFailure),
	).toBeNull()
	expect(filterSentryEvent(userModuleMessageFailure)).toBeNull()

	const platformBuildFailure = {
		exception: {
			values: [
				{
					value:
						'Build failed with 1 error:\npackages/worker/src/index.ts:1:0: ERROR: Unexpected "{"',
				},
			],
		},
	}
	expect(filterUserModuleBundlerFailureSentryEvent(platformBuildFailure)).toBe(
		platformBuildFailure,
	)
	expect(filterSentryEvent(platformBuildFailure)).toBe(platformBuildFailure)

	const unrelated = {
		exception: {
			values: [{ value: 'D1_ERROR: syntax error near INSERTZ' }],
		},
	}
	expect(filterUserModuleBundlerFailureSentryEvent(unrelated)).toBe(unrelated)
	expect(filterSentryEvent(unrelated)).toBe(unrelated)
})

test('filterExecutorSandboxTimeoutSentryEvent drops exact sandbox timeout message', () => {
	const sandboxTimeout = {
		exception: {
			values: [{ value: executorSandboxTimeoutMessage }],
		},
	}
	expect(filterExecutorSandboxTimeoutSentryEvent(sandboxTimeout)).toBeNull()
	expect(filterSentryEvent(sandboxTimeout)).toBeNull()

	const topLevelMessage = { message: executorSandboxTimeoutMessage }
	expect(filterExecutorSandboxTimeoutSentryEvent(topLevelMessage)).toBeNull()
	expect(filterSentryEvent(topLevelMessage)).toBeNull()

	const similarButDifferent = {
		exception: {
			values: [{ value: 'Webhook sync invocation timed out.' }],
		},
	}
	expect(filterExecutorSandboxTimeoutSentryEvent(similarButDifferent)).toBe(
		similarButDifferent,
	)
	expect(filterSentryEvent(similarButDifferent)).toBe(similarButDifferent)

	const prefixed = {
		exception: {
			values: [{ value: `Error: ${executorSandboxTimeoutMessage}` }],
		},
	}
	expect(filterExecutorSandboxTimeoutSentryEvent(prefixed)).toBe(prefixed)
	expect(filterSentryEvent(prefixed)).toBe(prefixed)
})

test('filterSentryEvent still drops retryable D1 lock contention', () => {
	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value: 'D1_ERROR: Currently processing a long-running export.',
					},
				],
			},
		}),
	).toBeNull()
})
