import { expect, test } from 'vitest'
import {
	handleWebhookSubscriptionChallenge,
	webhookChallengeAllowsGet,
	webhookChallengeMaxParamChars,
} from './challenge.ts'
import { computeWebhookHmacSignature } from './crypto.ts'

async function expectedXCrcResponseToken(crcToken: string, secret: string) {
	const tokenBytes = new TextEncoder().encode(crcToken)
	return computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret,
		body: tokenBytes.buffer.slice(
			tokenBytes.byteOffset,
			tokenBytes.byteOffset + tokenBytes.byteLength,
		) as ArrayBuffer,
		encoding: 'base64',
		prefix: 'sha256=',
	})
}

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

test('webhookChallengeAllowsGet matches GET-capable challenge types', () => {
	expect(
		webhookChallengeAllowsGet({
			type: 'x-activity-crc',
			secretName: 'x',
		}),
	).toBe(true)
	expect(webhookChallengeAllowsGet({ type: 'websub-hub' })).toBe(true)
	expect(
		webhookChallengeAllowsGet({
			type: 'meta-hub',
			secretName: 'meta',
		}),
	).toBe(true)
	expect(webhookChallengeAllowsGet({ type: 'slack-url-verification' })).toBe(
		false,
	)
	expect(webhookChallengeAllowsGet(null)).toBe(false)
})

test('x-activity-crc signs crc_token and rejects missing secret', async () => {
	const secrets = new Map([['xConsumerSecret', 'consumer-secret']])
	const crcToken = 'token-from-x'
	const result = await handleWebhookSubscriptionChallenge({
		request: new Request(
			`https://example.test/hook?crc_token=${encodeURIComponent(crcToken)}`,
		),
		challenge: { type: 'x-activity-crc', secretName: 'xConsumerSecret' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(result.kind).toBe('respond')
	if (result.kind !== 'respond') return
	expect(result.response.status).toBe(200)
	expect(await result.response.json()).toEqual({
		response_token: await expectedXCrcResponseToken(
			crcToken,
			'consumer-secret',
		),
	})

	const missingSecret = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook?crc_token=token'),
		challenge: { type: 'x-activity-crc', secretName: 'xConsumerSecret' },
		resolveSecret: async () => null,
	})
	expect(missingSecret.kind).toBe('respond')
	if (missingSecret.kind !== 'respond') return
	expect(missingSecret.response.status).toBe(401)

	const missingToken = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook'),
		challenge: { type: 'x-activity-crc', secretName: 'xConsumerSecret' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(missingToken.kind).toBe('respond')
	if (missingToken.kind !== 'respond') return
	expect(missingToken.response.status).toBe(400)

	const oversized = await handleWebhookSubscriptionChallenge({
		request: new Request(
			`https://example.test/hook?crc_token=${'x'.repeat(webhookChallengeMaxParamChars + 1)}`,
		),
		challenge: { type: 'x-activity-crc', secretName: 'xConsumerSecret' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(oversized.kind).toBe('respond')
	if (oversized.kind !== 'respond') return
	expect(oversized.response.status).toBe(400)

	const post = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook?crc_token=token', {
			method: 'POST',
		}),
		challenge: { type: 'x-activity-crc', secretName: 'xConsumerSecret' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(post).toEqual({ kind: 'not_challenge' })
})

test('websub-hub echoes challenge and rejects wrong verify token', async () => {
	const echo = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.challenge=abc123&hub.topic=https://example/topic',
		),
		challenge: { type: 'websub-hub' },
		resolveSecret: async () => null,
	})
	expect(echo.kind).toBe('respond')
	if (echo.kind !== 'respond') return
	expect(echo.response.status).toBe(200)
	expect(await echo.response.text()).toBe('abc123')
	expect(echo.response.headers.get('content-type')).toMatch(/text\/plain/)

	const secrets = new Map([['hubVerify', 'expected-token']])
	const wrongToken = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=wrong',
		),
		challenge: { type: 'websub-hub', secretName: 'hubVerify' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(wrongToken.kind).toBe('respond')
	if (wrongToken.kind !== 'respond') return
	expect(wrongToken.response.status).toBe(401)

	const missingSecret = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=expected-token',
		),
		challenge: { type: 'websub-hub', secretName: 'hubVerify' },
		resolveSecret: async () => null,
	})
	expect(missingSecret.kind).toBe('respond')
	if (missingSecret.kind !== 'respond') return
	expect(missingSecret.response.status).toBe(401)

	const matched = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=expected-token',
		),
		challenge: { type: 'websub-hub', secretName: 'hubVerify' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(matched.kind).toBe('respond')
	if (matched.kind !== 'respond') return
	expect(matched.response.status).toBe(200)
	expect(await matched.response.text()).toBe('abc123')
})

test('meta-hub requires verify token match and rejects missing secret', async () => {
	const secrets = new Map([['metaVerify', 'meta-token']])
	const ok = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.verify_token=meta-token&hub.challenge=42',
		),
		challenge: { type: 'meta-hub', secretName: 'metaVerify' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(ok.kind).toBe('respond')
	if (ok.kind !== 'respond') return
	expect(ok.response.status).toBe(200)
	expect(await ok.response.text()).toBe('42')

	const wrong = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42',
		),
		challenge: { type: 'meta-hub', secretName: 'metaVerify' },
		resolveSecret: async (name) => secrets.get(name) ?? null,
	})
	expect(wrong.kind).toBe('respond')
	if (wrong.kind !== 'respond') return
	expect(wrong.response.status).toBe(401)

	const missingSecret = await handleWebhookSubscriptionChallenge({
		request: new Request(
			'https://example.test/hook?hub.mode=subscribe&hub.verify_token=meta-token&hub.challenge=42',
		),
		challenge: { type: 'meta-hub', secretName: 'metaVerify' },
		resolveSecret: async () => null,
	})
	expect(missingSecret.kind).toBe('respond')
	if (missingSecret.kind !== 'respond') return
	expect(missingSecret.response.status).toBe(401)
})

test('slack-url-verification echoes challenge and rejects bad signatures', async () => {
	const body = JSON.stringify({
		type: 'url_verification',
		challenge: 'slack-challenge-token',
	})
	const echo = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		}),
		challenge: { type: 'slack-url-verification' },
		resolveSecret: async () => null,
		bodyText: body,
	})
	expect(echo.kind).toBe('respond')
	if (echo.kind !== 'respond') return
	expect(echo.response.status).toBe(200)
	expect(await echo.response.json()).toEqual({
		challenge: 'slack-challenge-token',
	})

	const eventBody = JSON.stringify({ type: 'event_callback', event: {} })
	const passthrough = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook', {
			method: 'POST',
			body: eventBody,
		}),
		challenge: { type: 'slack-url-verification' },
		resolveSecret: async () => null,
		bodyText: eventBody,
	})
	expect(passthrough).toEqual({ kind: 'not_challenge' })

	const signingSecret = 'slack-signing-secret'
	const timestamp = String(Math.floor(Date.now() / 1000))
	const signature = await expectedSlackSignature({
		timestamp,
		bodyText: body,
		signingSecret,
	})
	const signedOk = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-slack-request-timestamp': timestamp,
				'x-slack-signature': signature,
			},
			body,
		}),
		challenge: {
			type: 'slack-url-verification',
			secretName: 'slackSigningSecret',
		},
		resolveSecret: async (name) =>
			name === 'slackSigningSecret' ? signingSecret : null,
		bodyText: body,
	})
	expect(signedOk.kind).toBe('respond')
	if (signedOk.kind !== 'respond') return
	expect(signedOk.response.status).toBe(200)

	const badSig = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-slack-request-timestamp': timestamp,
				'x-slack-signature': 'v0=deadbeef',
			},
			body,
		}),
		challenge: {
			type: 'slack-url-verification',
			secretName: 'slackSigningSecret',
		},
		resolveSecret: async (name) =>
			name === 'slackSigningSecret' ? signingSecret : null,
		bodyText: body,
	})
	expect(badSig.kind).toBe('respond')
	if (badSig.kind !== 'respond') return
	expect(badSig.response.status).toBe(401)

	const missingSecret = await handleWebhookSubscriptionChallenge({
		request: new Request('https://example.test/hook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-slack-request-timestamp': timestamp,
				'x-slack-signature': signature,
			},
			body,
		}),
		challenge: {
			type: 'slack-url-verification',
			secretName: 'slackSigningSecret',
		},
		resolveSecret: async () => null,
		bodyText: body,
	})
	expect(missingSecret.kind).toBe('respond')
	if (missingSecret.kind !== 'respond') return
	expect(missingSecret.response.status).toBe(401)
})
