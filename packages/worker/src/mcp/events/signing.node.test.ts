import { createHmac } from 'node:crypto'
import { expect, test } from 'vitest'
import {
	buildSignedWebhookHeaders,
	buildWebhookSignatureHeader,
	decodeWebhookSecret,
	InvalidWebhookSecretError,
	signWebhookPayload,
} from './signing.ts'

function secretFromBytes(byteLength: number, fill = 7) {
	return `whsec_${Buffer.alloc(byteLength, fill).toString('base64')}`
}

/** Independent Standard Webhooks reference signer (node:crypto). */
function referenceSignature(input: {
	secret: string
	webhookId: string
	timestampSeconds: number
	body: string
}) {
	const key = Buffer.from(input.secret.slice('whsec_'.length), 'base64')
	return `v1,${createHmac('sha256', key)
		.update(`${input.webhookId}.${input.timestampSeconds}.${input.body}`)
		.digest('base64')}`
}

test('decodeWebhookSecret accepts whsec_ base64 keys of 24-64 bytes', () => {
	expect(decodeWebhookSecret(secretFromBytes(24)).byteLength).toBe(24)
	expect(decodeWebhookSecret(secretFromBytes(32)).byteLength).toBe(32)
	expect(decodeWebhookSecret(secretFromBytes(64)).byteLength).toBe(64)
})

test('decodeWebhookSecret rejects every shape the draft requires InvalidParams for', () => {
	const short = secretFromBytes(23)
	const long = secretFromBytes(65)
	const cases: Array<[string, RegExp]> = [
		[Buffer.alloc(32, 1).toString('base64'), /must start with "whsec_"/],
		['whsec_', /standard base64/],
		[`whsec_${Buffer.alloc(32, 250).toString('base64url')}`, /standard base64/],
		['whsec_abc', /standard base64/],
		[short, /24-64 bytes \(got 23\)/],
		[long, /24-64 bytes \(got 65\)/],
	]
	for (const [secret, message] of cases) {
		expect(() => decodeWebhookSecret(secret)).toThrow(InvalidWebhookSecretError)
		expect(() => decodeWebhookSecret(secret)).toThrow(message)
	}
})

test('signWebhookPayload matches an independent Standard Webhooks signer', async () => {
	const input = {
		secret: secretFromBytes(32, 42),
		webhookId: 'evt_0123456789abcdef',
		timestampSeconds: 1_760_000_000,
		body: JSON.stringify({ eventId: 'evt_1', name: 'demo.ping', data: {} }),
	}
	const signature = await signWebhookPayload(input)
	expect(signature).toBe(referenceSignature(input))
	expect(signature).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
	// Any change to id, timestamp, or body changes the signature.
	await expect(
		signWebhookPayload({ ...input, body: `${input.body} ` }),
	).resolves.not.toBe(signature)
	await expect(
		signWebhookPayload({ ...input, timestampSeconds: 1_760_000_001 }),
	).resolves.not.toBe(signature)
})

test('rotation: one space-delimited signature per secret, current first', async () => {
	const current = secretFromBytes(32, 1)
	const previous = secretFromBytes(32, 2)
	const base = {
		webhookId: 'evt_rotation',
		timestampSeconds: 1_760_000_000,
		body: '{}',
	}
	const header = await buildWebhookSignatureHeader({
		...base,
		secrets: [current, previous],
	})
	expect(header.split(' ')).toEqual([
		referenceSignature({ ...base, secret: current }),
		referenceSignature({ ...base, secret: previous }),
	])
	await expect(
		buildWebhookSignatureHeader({ ...base, secrets: [] }),
	).rejects.toThrow(/At least one webhook signing secret/)
})

test('buildSignedWebhookHeaders emits the Standard Webhooks and MCP headers', async () => {
	const secret = secretFromBytes(32, 9)
	const now = new Date('2026-10-07T12:00:00.500Z')
	const headers = await buildSignedWebhookHeaders({
		secrets: [secret],
		webhookId: 'evt_headers',
		subscriptionId: 'sub_abc',
		body: '{"ok":true}',
		now,
	})
	const timestampSeconds = Math.floor(now.getTime() / 1000)
	expect(headers).toEqual({
		'Content-Type': 'application/json',
		'webhook-id': 'evt_headers',
		'webhook-timestamp': String(timestampSeconds),
		'webhook-signature': referenceSignature({
			secret,
			webhookId: 'evt_headers',
			timestampSeconds,
			body: '{"ok":true}',
		}),
		'X-MCP-Subscription-Id': 'sub_abc',
	})
})
