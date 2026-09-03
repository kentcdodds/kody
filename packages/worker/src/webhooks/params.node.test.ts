import { expect, test } from 'vitest'
import {
	buildWebhookCallerIdempotencyHashParams,
	readWebhookCallerIdempotencyKey,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'

test('params-mode first-arg unwrap and caller Idempotency-Key resolution', () => {
	expect(resolveWebhookParamsModeFirstArg(null)).toEqual({
		ok: false,
		code: 'invalid_params',
	})
	expect(resolveWebhookParamsModeFirstArg(['event'])).toEqual({
		ok: false,
		code: 'invalid_params',
	})
	expect(resolveWebhookParamsModeFirstArg('event')).toEqual({
		ok: false,
		code: 'invalid_params',
	})

	const direct = { messageId: 'm-1', content: 'hello' }
	expect(resolveWebhookParamsModeFirstArg(direct)).toEqual({
		ok: true,
		params: direct,
	})

	const envelope = {
		params: { messageId: 'm-2', content: 'invoke' },
		idempotencyKey: 'evt-2',
		source: 'discord-gateway',
	}
	expect(resolveWebhookParamsModeFirstArg(envelope)).toEqual({
		ok: true,
		params: { messageId: 'm-2', content: 'invoke' },
	})
	expect(
		resolveWebhookParamsModeFirstArg({
			params: 'not-an-object',
			other: true,
		}),
	).toEqual({
		ok: true,
		params: { params: 'not-an-object', other: true },
	})

	const headerRequest = new Request('https://test.kody.dev/hook', {
		method: 'POST',
		headers: { 'Idempotency-Key': ' header-key ' },
		body: JSON.stringify({ idempotencyKey: 'body-key', params: { n: 1 } }),
	})
	expect(
		readWebhookCallerIdempotencyKey({
			request: headerRequest,
			json: { idempotencyKey: 'body-key', params: { n: 1 } },
			allowBodyKey: true,
		}),
	).toBe('header-key')

	const bodyRequest = new Request('https://test.kody.dev/hook', {
		method: 'POST',
		body: '{}',
	})
	expect(
		readWebhookCallerIdempotencyKey({
			request: bodyRequest,
			json: { idempotencyKey: '  body-only  ', params: { n: 1 } },
			allowBodyKey: true,
		}),
	).toBe('body-only')
	expect(
		readWebhookCallerIdempotencyKey({
			request: bodyRequest,
			json: { idempotencyKey: 'body-only', params: { n: 1 } },
			allowBodyKey: false,
		}),
	).toBeNull()

	expect(
		buildWebhookCallerIdempotencyHashParams({
			json: { event: 'push' },
			bodyText: '{"event":"push"}',
		}),
	).toEqual({ event: 'push' })
	expect(
		buildWebhookCallerIdempotencyHashParams({
			json: null,
			bodyText: 'not-json',
		}),
	).toEqual({ body: 'not-json' })
})
