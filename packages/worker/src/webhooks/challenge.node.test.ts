import { expect, test } from 'vitest'
import {
	handleWebhookSubscriptionChallenge,
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

test('x-activity-crc signs crc_token and rejects missing secret', async () => {
	const challenge = {
		type: 'x-activity-crc',
		secretName: 'xConsumerSecret',
	} as const
	const secrets = { xConsumerSecret: 'consumer-secret' }
	const signed = await challengeOutcome({
		request: `?crc_token=${encodeURIComponent('token-from-x')}`,
		challenge,
		secrets,
	})
	expect(signed).toMatchObject({ status: 200 })
	expect(JSON.parse((signed as { body: string }).body)).toEqual({
		response_token: 'sha256=W5nrYAN+2ikisJKlZgv84WstpdpbgeYwmuf7ojn/Qn0=',
	})

	expect(
		await statusesOf([
			{ request: '?crc_token=token', challenge },
			{ request: '', challenge, secrets },
			{
				request: `?crc_token=${'x'.repeat(webhookChallengeMaxParamChars + 1)}`,
				challenge,
				secrets,
			},
			{
				request: new Request('https://example.test/hook?crc_token=token', {
					method: 'POST',
				}),
				challenge,
				secrets,
			},
		]),
	).toEqual([401, 400, 400, { kind: 'not_challenge' }])
})

test('websub-hub echoes challenge and rejects wrong verify token', async () => {
	const subscribe = '?hub.mode=subscribe&hub.challenge=abc123'
	const echo = await challengeOutcome({
		request: `${subscribe}&hub.topic=https://example/topic`,
		challenge: { type: 'websub-hub' },
	})
	expect(echo).toMatchObject({ status: 200, body: 'abc123' })
	expect((echo as { contentType: string }).contentType).toMatch(/text\/plain/)

	const challenge = { type: 'websub-hub', secretName: 'hubVerify' } as const
	const secrets = { hubVerify: 'expected-token' }
	expect(
		await statusesOf([
			{ request: `${subscribe}&hub.verify_token=wrong`, challenge, secrets },
			{ request: `${subscribe}&hub.verify_token=expected-token`, challenge },
		]),
	).toEqual([401, 401])
	expect(
		await challengeOutcome({
			request: `${subscribe}&hub.verify_token=expected-token`,
			challenge,
			secrets,
		}),
	).toMatchObject({ status: 200, body: 'abc123' })
})

test('meta-hub requires verify token match and rejects missing secret', async () => {
	const challenge = { type: 'meta-hub', secretName: 'metaVerify' } as const
	const secrets = { metaVerify: 'meta-token' }
	const request = (token: string) =>
		`?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`
	expect(
		await challengeOutcome({
			request: request('meta-token'),
			challenge,
			secrets,
		}),
	).toMatchObject({ status: 200, body: '42' })
	expect(
		await statusesOf([
			{ request: request('nope'), challenge, secrets },
			{ request: request('meta-token'), challenge },
		]),
	).toEqual([401, 401])
})

test('strava-hub returns JSON hub.challenge and rejects bad verify tokens', async () => {
	const challenge = {
		type: 'strava-hub',
		secretName: 'stravaVerify',
	} as const
	const secrets = { stravaVerify: 'STRAVA' }
	const subscribe =
		'?hub.mode=subscribe&hub.verify_token=STRAVA&hub.challenge=15f7d1a91c1f40f8a748fd134752feb3'
	const ok = await challengeOutcome({
		request: subscribe,
		challenge,
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
				challenge,
				secrets,
			},
			{
				request:
					'?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=STRAVA',
				challenge,
			},
			{
				request:
					'?hub.mode=unsubscribe&hub.verify_token=STRAVA&hub.challenge=abc',
				challenge,
				secrets,
			},
			{
				request: new Request(
					'https://example.test/hook?hub.mode=subscribe&hub.verify_token=STRAVA&hub.challenge=abc',
					{ method: 'POST' },
				),
				challenge,
				secrets,
			},
		]),
	).toEqual([401, 401, 400, { kind: 'not_challenge' }])
})

test('slack-url-verification echoes challenge and rejects bad signatures', async () => {
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
		challenge: { type: 'slack-url-verification' },
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
			challenge: { type: 'slack-url-verification' },
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
	const challenge = {
		type: 'slack-url-verification',
		secretName: 'slackSigningSecret',
	} as const
	const secrets = { slackSigningSecret: signingSecret }
	expect(
		await statusesOf([
			{ request: signed(signature), challenge, secrets, bodyText: body },
			{ request: signed('v0=deadbeef'), challenge, secrets, bodyText: body },
			{ request: signed(signature), challenge, bodyText: body },
		]),
	).toEqual([200, 401, 401])
})
