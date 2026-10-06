import { expect, test } from 'vitest'
import {
	buildWebhookDispatchFailureLogs,
	readWebhookInvocationError,
} from './delivery.ts'

test('webhook failure helpers surface invocation codes for Activity logs', () => {
	expect(
		readWebhookInvocationError({
			ok: false,
			error: {
				code: 'artifact_preparation_failed',
				message: 'Package artifact preparation failed before execution.',
			},
		}),
	).toEqual({
		code: 'artifact_preparation_failed',
		message: 'Package artifact preparation failed before execution.',
	})
	expect(readWebhookInvocationError({ ok: true })).toEqual({
		code: null,
		message: null,
	})

	const logs = buildWebhookDispatchFailureLogs({
		httpStatus: 500,
		body: {
			ok: false,
			error: {
				code: 'invocation_failed',
				message: 'boom',
			},
		},
	})
	expect(logs).toEqual([
		{
			level: 'error',
			message: 'Webhook export invocation failed with HTTP 500.',
		},
		{
			level: 'error',
			message: 'Invocation error code: invocation_failed',
			fields: { code: 'invocation_failed', detail: 'boom' },
		},
	])

	const exhausted = buildWebhookDispatchFailureLogs({
		httpStatus: 503,
		body: {
			ok: false,
			error: { code: 'artifact_preparation_failed' },
		},
		exhausted: true,
		attempts: 10,
	})
	expect(exhausted[0]).toMatchObject({
		level: 'error',
		message: 'Webhook dispatch gave up after 10 retries.',
	})
})
