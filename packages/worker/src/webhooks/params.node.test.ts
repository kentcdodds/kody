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
		topic: 'discord.message.created',
	}
	expect(resolveWebhookParamsModeFirstArg(envelope)).toEqual({
		ok: true,
		params: { messageId: 'm-2', content: 'invoke' },
	})
	expect(
		resolveWebhookParamsModeFirstArg({
			params: { fileSizeBytes: 12 },
		}),
	).toEqual({
		ok: true,
		params: { fileSizeBytes: 12 },
	})
	const routed = {
		route: 'linkedin/register-video-upload',
		dryRun: false,
		params: { fileSizeBytes: 12, confirm: true },
	}
	expect(resolveWebhookParamsModeFirstArg(routed)).toEqual({
		ok: true,
		params: routed,
	})
	const routedWithEnvelopeKeys = {
		route: 'x',
		dryRun: true,
		params: { a: 1 },
		idempotencyKey: 'evt-1',
		source: 'promo-scheduler',
		topic: 'linkedin',
	}
	expect(resolveWebhookParamsModeFirstArg(routedWithEnvelopeKeys)).toEqual({
		ok: true,
		params: routedWithEnvelopeKeys,
	})
	const topicObject = {
		params: { page: 1 },
		topic: { category: 'news' },
	}
	expect(resolveWebhookParamsModeFirstArg(topicObject)).toEqual({
		ok: true,
		params: topicObject,
	})
	const numericIdempotencyKey = {
		params: { a: 1 },
		idempotencyKey: 12,
	}
	expect(resolveWebhookParamsModeFirstArg(numericIdempotencyKey)).toEqual({
		ok: true,
		params: numericIdempotencyKey,
	})
	const blankIdempotencyKey = {
		params: { a: 1 },
		idempotencyKey: '   ',
	}
	expect(resolveWebhookParamsModeFirstArg(blankIdempotencyKey)).toEqual({
		ok: true,
		params: blankIdempotencyKey,
	})
	expect(
		resolveWebhookParamsModeFirstArg({
			params: { a: 1 },
			idempotencyKey: 'evt-1',
			source: null,
			topic: null,
		}),
	).toEqual({
		ok: true,
		params: { a: 1 },
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
			json: null,
			bodyText: 'not-json',
		}),
	).toEqual({ body: 'not-json' })
})
