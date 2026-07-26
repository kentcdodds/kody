import { expect, test } from 'vitest'
import {
	executorSandboxTimeoutMessage,
	filterSentryEvent,
} from './sentry-options.ts'

test('filterSentryEvent drops expected platform and caller noise and keeps real errors', () => {
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
						value: 'Currently processing a long-running export.',
					},
					{
						value: 'D1_ERROR: Currently processing a long-running export.',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterSentryEvent({
			exception: {
				values: [{ value: 'Network connection lost.' }],
			},
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			exception: {
				values: [{ value: 'D1_ERROR: Network connection lost.' }],
			},
		}),
	).toBeNull()

	const unrelatedNetworkLoss = {
		exception: {
			values: [{ value: 'Network connection lost while uploading...' }],
		},
	}
	expect(filterSentryEvent(unrelatedNetworkLoss)).toBe(unrelatedNetworkLoss)

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
	expect(filterSentryEvent(userModuleBuildFailure)).toBeNull()
	expect(
		filterSentryEvent({
			message:
				'Build failed with 1 error:\nvirtual:.__kody_root__/entry.ts:11:49: ERROR: Unexpected "^"',
		}),
	).toBeNull()

	const sandboxTimeout = {
		exception: {
			values: [{ value: executorSandboxTimeoutMessage }],
		},
	}
	expect(filterSentryEvent(sandboxTimeout)).toBeNull()
	expect(
		filterSentryEvent({ message: executorSandboxTimeoutMessage }),
	).toBeNull()

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
	expect(filterSentryEvent(platformBuildFailure)).toBe(platformBuildFailure)

	const syntaxError = {
		exception: {
			values: [{ value: 'D1_ERROR: syntax error near INSERTZ' }],
		},
	}
	expect(filterSentryEvent(syntaxError)).toBe(syntaxError)

	const webhookTimeout = {
		exception: {
			values: [{ value: 'Webhook sync invocation timed out.' }],
		},
	}
	expect(filterSentryEvent(webhookTimeout)).toBe(webhookTimeout)

	const prefixedSandboxTimeout = {
		exception: {
			values: [{ value: `Error: ${executorSandboxTimeoutMessage}` }],
		},
	}
	expect(filterSentryEvent(prefixedSandboxTimeout)).toBe(prefixedSandboxTimeout)
})
