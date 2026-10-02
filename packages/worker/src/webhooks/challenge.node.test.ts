import { expect, test } from 'vitest'
import {
	handleWebhookSubscriptionChallenge,
	normalizeWebhookChallenge,
	webhookChallengeAllowsGet,
	webhookChallengeAllowsPost,
	webhookChallengeMaxParamChars,
} from './challenge.ts'
import { computeWebhookHmacSignature } from './crypto.ts'

async function expectedSlackSignature(input: {
	timestamp: string
	bodyText: string
	signingSecret: string
}) {
	const base = new TextEncoder().encode(
		`v0:${input.timestamp}:${input.bodyText}`,
	)
	return computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: input.signingSecret,
		body: base.buffer.slice(
			base.byteOffset,
			base.byteOffset + base.byteLength,
		) as ArrayBuffer,
		encoding: 'hex',
		prefix: 'v0=',
	})
}

type Challenge = Parameters<
	typeof handleWebhookSubscriptionChallenge
>[0]['challenge']

async function challengeOutcome(input: {
	request: Request | string
	challenge: Challenge
	secrets?: Record<string, string>
	bodyText?: string
}) {
	const result = await handleWebhookSubscriptionChallenge({
		request:
			typeof input.request === 'string'
				? new Request(`https://example.test/hook${input.request}`)
				: input.request,
		challenge: input.challenge,
		resolveSecret: async (name) => input.secrets?.[name] ?? null,
		bodyText: input.bodyText,
	})
	if (result.kind !== 'respond') return result
	return {
		status: result.response.status,
		contentType: result.response.headers.get('content-type'),
		body: await result.response.text(),
	}
}

const statusesOf = async (
	cases: Array<Parameters<typeof challengeOutcome>[0]>,
) =>
	Promise.all(
		cases.map(async (input) => {
			const outcome = await challengeOutcome(input)
			return 'status' in outcome ? outcome.status : outcome
		}),
	)

const crcChallenge = {
	type: 'subscription-challenge',
	method: 'GET',
	challenge: { in: 'query', key: 'crc_token' },
	prove: {
		kind: 'hmac',
		secretName: 'xConsumerSecret',
		algorithm: 'hmac-sha256',
		encoding: 'base64',
		prefix: 'sha256=',
	},
	respond: { as: 'json-hmac', key: 'response_token' },
} as const

const webSubChallenge: Challenge = {
	type: 'subscription-challenge',
	method: 'GET',
	challenge: { in: 'query', key: 'hub.challenge' },
	when: { query: { 'hub.mode': ['subscribe', 'unsubscribe'] } },
	respond: { as: 'text' },
}

const webSubWithVerify: Challenge = {
	...webSubChallenge,
	prove: {
		kind: 'verify-token',
		in: 'query',
		key: 'hub.verify_token',
		secretName: 'hubVerify',
		required: true,
	},
}

const metaHubChallenge = {
	type: 'subscription-challenge',
	method: 'GET',
	challenge: { in: 'query', key: 'hub.challenge' },
	when: { query: { 'hub.mode': 'subscribe' } },
	prove: {
		kind: 'verify-token',
		in: 'query',
		key: 'hub.verify_token',
		secretName: 'metaVerify',
		required: true,
	},
	respond: { as: 'text' },
} as const

const stravaHubChallenge = {
	type: 'subscription-challenge',
	method: 'GET',
	challenge: { in: 'query', key: 'hub.challenge' },
	when: { query: { 'hub.mode': 'subscribe' } },
	prove: {
		kind: 'verify-token',
		in: 'query',
		key: 'hub.verify_token',
		secretName: 'stravaVerify',
		required: true,
	},
	respond: { as: 'json', key: 'hub.challenge' },
} as const

const slackChallenge = {
	type: 'subscription-challenge',
	method: 'POST',
	challenge: { in: 'json', key: 'challenge' },
	when: { json: { type: 'url_verification' } },
	respond: { as: 'json', key: 'challenge' },
} as const

const slackChallengeSigned = {
	...slackChallenge,
	prove: {
		kind: 'request-hmac',
		secretName: 'slackSigningSecret',
		algorithm: 'hmac-sha256',
		encoding: 'hex',
		prefix: 'v0=',
		timestampHeader: 'x-slack-request-timestamp',
		signatureHeader: 'x-slack-signature',
		signedPayload: 'v0.timestamp.body',
	},
} as const

test('normalizeWebhookChallenge is identity for subscription-challenge', () => {
	expect(normalizeWebhookChallenge(stravaHubChallenge)).toEqual(
		stravaHubChallenge,
	)
	expect(normalizeWebhookChallenge(metaHubChallenge).respond).toEqual({
		as: 'text',
	})
	expect(webhookChallengeAllowsGet(webSubChallenge)).toBe(true)
	expect(webhookChallengeAllowsPost(slackChallenge)).toBe(true)
	expect(webhookChallengeAllowsPost(metaHubChallenge)).toBe(false)
})

test('CRC preset signs crc_token and rejects missing secret', async () => {
	const secrets = { xConsumerSecret: 'consumer-secret' }
	const signed = await challengeOutcome({
		request: `?crc_token=${encodeURIComponent('token-from-x')}`,
		challenge: crcChallenge,
		secrets,
	})
	expect(signed).toMatchObject({ status: 200 })
	expect(JSON.parse((signed as { body: string }).body)).toEqual({
		response_token: 'sha256=W5nrYAN+2ikisJKlZgv84WstpdpbgeYwmuf7ojn/Qn0=',
	})

	expect(
		await statusesOf([
			{ request: '?crc_token=token', challenge: crcChallenge },
			{ request: '', challenge: crcChallenge, secrets },
			{
				request: `?crc_token=${'x'.repeat(webhookChallengeMaxParamChars + 1)}`,
				challenge: crcChallenge,
				secrets,
			},
			{
				request: new Request('https://example.test/hook?crc_token=token', {
					method: 'POST',
				}),
				challenge: crcChallenge,
				secrets,
			},
		]),
	).toEqual([401, 400, 400, { kind: 'not_challenge' }])
})

test('WebSub preset echoes challenge and rejects wrong verify token', async () => {
	const subscribe = '?hub.mode=subscribe&hub.challenge=abc123'
	const echo = await challengeOutcome({
		request: `${subscribe}&hub.topic=https://example/topic`,
		challenge: webSubChallenge,
	})
	expect(echo).toMatchObject({ status: 200, body: 'abc123' })
	expect((echo as { contentType: string }).contentType).toMatch(/text\/plain/)

	const secrets = { hubVerify: 'expected-token' }
	expect(
		await statusesOf([
			{
				request: `${subscribe}&hub.verify_token=wrong`,
				challenge: webSubWithVerify,
				secrets,
			},
			{
				request: `${subscribe}&hub.verify_token=expected-token`,
				challenge: webSubWithVerify,
			},
		]),
	).toEqual([401, 401])
	expect(
		await challengeOutcome({
			request: `${subscribe}&hub.verify_token=expected-token`,
			challenge: webSubWithVerify,
			secrets,
		}),
	).toMatchObject({ status: 200, body: 'abc123' })
})

test('hub text preset requires verify token match and rejects missing secret', async () => {
	const secrets = { metaVerify: 'meta-token' }
	const request = (token: string) =>
		`?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`
	expect(
		await challengeOutcome({
			request: request('meta-token'),
			challenge: metaHubChallenge,
			secrets,
		}),
	).toMatchObject({ status: 200, body: '42' })
	expect(
		await statusesOf([
			{ request: request('nope'), challenge: metaHubChallenge, secrets },
			{ request: request('meta-token'), challenge: metaHubChallenge },
		]),
	).toEqual([401, 401])
})

test('hub JSON preset returns JSON hub.challenge', async () => {
	const secrets = { stravaVerify: 'STRAVA' }
	const subscribe =
		'?hub.mode=subscribe&hub.verify_token=STRAVA&hub.challenge=15f7d1a91c1f40f8a748fd134752feb3'
	const ok = await challengeOutcome({
		request: subscribe,
		challenge: stravaHubChallenge,
		secrets,
	})
	expect(ok).toMatchObject({ status: 200 })
	expect((ok as { contentType: string }).contentType).toMatch(
		/application\/json/,
	)
	expect(JSON.parse((ok as { body: string }).body)).toEqual({
		'hub.challenge': '15f7d1a91c1f40f8a748fd134752feb3',
	})

	expect(
		await statusesOf([
			{
				request: '?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc',
				challenge: stravaHubChallenge,
				secrets,
			},
			{
				request:
					'?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=STRAVA',
				challenge: stravaHubChallenge,
			},
			{
				request:
					'?hub.mode=unsubscribe&hub.verify_token=STRAVA&hub.challenge=abc',
				challenge: stravaHubChallenge,
				secrets,
			},
			{
				request: new Request(
					'https://example.test/hook?hub.mode=subscribe&hub.verify_token=STRAVA&hub.challenge=abc',
					{ method: 'POST' },
				),
				challenge: stravaHubChallenge,
				secrets,
			},
		]),
	).toEqual([401, 401, 400, { kind: 'not_challenge' }])
})

test('JSON body challenge preset echoes challenge and rejects bad signatures', async () => {
	const body = JSON.stringify({
		type: 'url_verification',
		challenge: 'slack-challenge-token',
	})
	const post = (bodyText: string, headers: Record<string, string> = {}) =>
		new Request('https://example.test/hook', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: bodyText,
		})
	const echo = await challengeOutcome({
		request: post(body),
		challenge: slackChallenge,
		bodyText: body,
	})
	expect(echo).toMatchObject({ status: 200 })
	expect(JSON.parse((echo as { body: string }).body)).toEqual({
		challenge: 'slack-challenge-token',
	})

	const eventBody = JSON.stringify({ type: 'event_callback', event: {} })
	expect(
		await challengeOutcome({
			request: post(eventBody),
			challenge: slackChallenge,
			bodyText: eventBody,
		}),
	).toEqual({ kind: 'not_challenge' })

	const signingSecret = 'slack-signing-secret'
	const timestamp = String(Math.floor(Date.now() / 1000))
	const signature = await expectedSlackSignature({
		timestamp,
		bodyText: body,
		signingSecret,
	})
	const signed = (slackSignature: string) =>
		post(body, {
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': slackSignature,
		})
	const secrets = { slackSigningSecret: signingSecret }
	expect(
		await statusesOf([
			{
				request: signed(signature),
				challenge: slackChallengeSigned,
				secrets,
				bodyText: body,
			},
			{
				request: signed('v0=deadbeef'),
				challenge: slackChallengeSigned,
				secrets,
				bodyText: body,
			},
			{
				request: signed(signature),
				challenge: slackChallengeSigned,
				bodyText: body,
			},
		]),
	).toEqual([200, 401, 401])
})

test('POST challenge without when falls through when challenge field is absent', async () => {
	const body = JSON.stringify({ event: 'updated' })
	expect(
		await challengeOutcome({
			request: new Request('https://example.test/hook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			challenge: {
				type: 'subscription-challenge',
				method: 'POST',
				challenge: { in: 'json', key: 'challenge' },
				respond: { as: 'json', key: 'challenge' },
			},
			bodyText: body,
		}),
	).toEqual({ kind: 'not_challenge' })
})

test('POST challenge with when rejects missing challenge field after match', async () => {
	const body = JSON.stringify({ type: 'url_verification' })
	expect(
		await challengeOutcome({
			request: new Request('https://example.test/hook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
			challenge: {
				type: 'subscription-challenge',
				method: 'POST',
				challenge: { in: 'json', key: 'challenge' },
				when: { json: { type: 'url_verification' } },
				respond: { as: 'json', key: 'challenge' },
			},
			bodyText: body,
		}),
	).toMatchObject({ status: 400 })
})
