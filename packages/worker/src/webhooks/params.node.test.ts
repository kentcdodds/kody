import { expect, test } from 'vitest'
import {
	buildWebhookCallerIdempotencyHashParams,
	readWebhookCallerIdempotencyKey,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'

test('params-mode first-arg unwrap and caller Idempotency-Key resolution', () => {
	const routed = {
		route: 'linkedin/register-video-upload',
		dryRun: false,
		params: { fileSizeBytes: 12, confirm: true },
	}
	const routedWithEnvelopeKeys = {
		route: 'x',
		dryRun: true,
		params: { a: 1 },
		idempotencyKey: 'evt-1',
		source: 'promo-scheduler',
		topic: 'linkedin',
	}
	const topicObject = { params: { page: 1 }, topic: { category: 'news' } }
	const numericIdempotencyKey = { params: { a: 1 }, idempotencyKey: 12 }
	const blankIdempotencyKey = { params: { a: 1 }, idempotencyKey: '   ' }
	const unwrapCases: Array<[input: unknown, params: unknown]> = [
		[null, null],
		[['event'], null],
		['event', null],
		[
			{ messageId: 'm-1', content: 'hello' },
			{ messageId: 'm-1', content: 'hello' },
		],
		[
			{
				params: { messageId: 'm-2', content: 'invoke' },
				idempotencyKey: 'evt-2',
				source: 'discord-gateway',
				topic: 'discord.message.created',
			},
			{ messageId: 'm-2', content: 'invoke' },
		],
		[{ params: { fileSizeBytes: 12 } }, { fileSizeBytes: 12 }],
		[routed, routed],
		[routedWithEnvelopeKeys, routedWithEnvelopeKeys],
		[topicObject, topicObject],
		[numericIdempotencyKey, numericIdempotencyKey],
		[blankIdempotencyKey, blankIdempotencyKey],
		[
			{ params: { a: 1 }, idempotencyKey: 'evt-1', source: null, topic: null },
			{ a: 1 },
		],
		[
			{ params: 'not-an-object', other: true },
			{ params: 'not-an-object', other: true },
		],
	]
	expect(
		unwrapCases.map(([input]) => resolveWebhookParamsModeFirstArg(input)),
	).toEqual(
		unwrapCases.map(([, params]) =>
			params === null
				? { ok: false, code: 'invalid_params' }
				: { ok: true, params },
		),
	)

	const headerRequest = new Request('https://test.kody.dev/hook', {
		method: 'POST',
		headers: { 'Idempotency-Key': ' header-key ' },
		body: JSON.stringify({ idempotencyKey: 'body-key', params: { n: 1 } }),
	})
	const bodyRequest = new Request('https://test.kody.dev/hook', {
		method: 'POST',
		body: '{}',
	})
	const keyCases = [
		[headerRequest, 'body-key', true, 'header-key'],
		[bodyRequest, '  body-only  ', true, 'body-only'],
		[bodyRequest, 'body-only', false, null],
	] as const
	expect(
		keyCases.map(([request, idempotencyKey, allowBodyKey]) =>
			readWebhookCallerIdempotencyKey({
				request,
				json: { idempotencyKey, params: { n: 1 } },
				allowBodyKey,
			}),
		),
	).toEqual(keyCases.map(([, , , want]) => want))

	expect(
		buildWebhookCallerIdempotencyHashParams({
			json: null,
			bodyText: 'not-json',
		}),
	).toEqual({ body: 'not-json' })
})
