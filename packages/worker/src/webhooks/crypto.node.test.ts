import { expect, test } from 'vitest'
import {
	buildWebhookDeliveryIdempotencyKey,
	buildWebhookTimestampBodyPayload,
	computeWebhookHmacSignature,
	generateWebhookUrlSecret,
	hashWebhookUrlSecret,
	isWebhookTimestampWithinTolerance,
	parseWebhookReplayTimestamp,
	providedWebhookHmacValues,
	verifyWebhookHmacSignature,
	webhookUrlSecretMatches,
} from './crypto.ts'

test('webhook URL secrets hash for storage and compare in constant time', async () => {
	const secret = await generateWebhookUrlSecret()
	const hash = await hashWebhookUrlSecret(secret)
	expect(hash).not.toBe(secret)
	expect(
		await webhookUrlSecretMatches({ candidate: secret, storedHash: hash }),
	).toBe(true)
	expect(
		await webhookUrlSecretMatches({
			candidate: `${secret}x`,
			storedHash: hash,
		}),
	).toBe(false)
})

test('HMAC signatures cover GitHub-style prefixed hex and raw hex', async () => {
	const body = new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer
	const github = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: 'topsecret',
		body,
		encoding: 'hex',
		prefix: 'sha256=',
	})
	expect(github.startsWith('sha256=')).toBe(true)
	expect(
		await verifyWebhookHmacSignature({
			algorithm: 'hmac-sha256',
			secret: 'topsecret',
			body,
			encoding: 'hex',
			prefix: 'sha256=',
			provided: github,
		}),
	).toBe(true)
	expect(
		await verifyWebhookHmacSignature({
			algorithm: 'hmac-sha256',
			secret: 'topsecret',
			body,
			encoding: 'hex',
			prefix: 'sha256=',
			provided: 'sha256=00',
		}),
	).toBe(false)

	const sentry = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: 'sentry-secret',
		body,
		encoding: 'hex',
	})
	expect(sentry.includes('=')).toBe(false)
	expect(
		await verifyWebhookHmacSignature({
			algorithm: 'hmac-sha256',
			secret: 'sentry-secret',
			body,
			encoding: 'hex',
			provided: sentry,
		}),
	).toBe(true)
})

test('webhook replay timestamps parse unix, iso, and stripe formats and reject missing or junk values', async () => {
	const bodyText = '{"ok":true}'
	const body = new TextEncoder().encode(bodyText).buffer as ArrayBuffer
	const unixSeconds = 1_780_000_000
	expect(
		parseWebhookReplayTimestamp({
			headerValue: String(unixSeconds),
			format: 'unix-seconds',
		}),
	).toEqual({
		ok: true,
		timestampMs: unixSeconds * 1000,
		timestampToken: String(unixSeconds),
	})
	expect(
		parseWebhookReplayTimestamp({
			headerValue: String(unixSeconds * 1000),
			format: 'unix-millis',
		}),
	).toEqual({
		ok: true,
		timestampMs: unixSeconds * 1000,
		timestampToken: String(unixSeconds * 1000),
	})
	expect(
		parseWebhookReplayTimestamp({
			headerValue: '2026-09-02T18:00:00.000Z',
			format: 'iso-8601',
		}),
	).toEqual({
		ok: true,
		timestampMs: Date.parse('2026-09-02T18:00:00.000Z'),
		timestampToken: '2026-09-02T18:00:00.000Z',
	})
	expect(
		parseWebhookReplayTimestamp({
			headerValue: `t=${unixSeconds},v1=abc`,
			format: 'stripe-signature',
		}),
	).toEqual({
		ok: true,
		timestampMs: unixSeconds * 1000,
		timestampToken: String(unixSeconds),
	})
	expect(
		parseWebhookReplayTimestamp({
			headerValue: null,
			format: 'unix-seconds',
		}),
	).toEqual({ ok: false, reason: 'missing' })
	expect(
		parseWebhookReplayTimestamp({
			headerValue: 'not-a-time',
			format: 'iso-8601',
		}),
	).toEqual({ ok: false, reason: 'unparseable' })
	expect(
		isWebhookTimestampWithinTolerance({
			timestampMs: unixSeconds * 1000,
			nowMs: unixSeconds * 1000 + 299_000,
			toleranceSeconds: 300,
		}),
	).toBe(true)
	expect(
		isWebhookTimestampWithinTolerance({
			timestampMs: unixSeconds * 1000,
			nowMs: unixSeconds * 1000 + 301_000,
			toleranceSeconds: 300,
		}),
	).toBe(false)

	const timestampPayload = buildWebhookTimestampBodyPayload({
		timestampToken: String(unixSeconds),
		body,
	})
	const timestampBodySignature = await computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret: 'whsec_test',
		body: timestampPayload,
		encoding: 'hex',
	})
	expect(
		await verifyWebhookHmacSignature({
			algorithm: 'hmac-sha256',
			secret: 'whsec_test',
			body,
			encoding: 'hex',
			provided: timestampBodySignature,
		}),
	).toBe(false)
	expect(
		await verifyWebhookHmacSignature({
			algorithm: 'hmac-sha256',
			secret: 'whsec_test',
			body: timestampPayload,
			encoding: 'hex',
			provided: timestampBodySignature,
		}),
	).toBe(true)
	expect(
		providedWebhookHmacValues({
			provided: `t=${unixSeconds},v1=${timestampBodySignature}`,
			verificationHeader: 'Stripe-Signature',
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
		}),
	).toEqual([timestampBodySignature])

	const firstKey = await buildWebhookDeliveryIdempotencyKey({
		userId: 'user-1',
		packageId: 'pkg-1',
		webhookName: 'github',
		deliveryId: 'delivery-1',
	})
	const sameKey = await buildWebhookDeliveryIdempotencyKey({
		userId: 'user-1',
		packageId: 'pkg-1',
		webhookName: 'github',
		deliveryId: 'delivery-1',
	})
	const otherKey = await buildWebhookDeliveryIdempotencyKey({
		userId: 'user-1',
		packageId: 'pkg-1',
		webhookName: 'github',
		deliveryId: 'delivery-2',
	})
	expect(firstKey).toBe(sameKey)
	expect(firstKey).not.toBe(otherKey)
	expect(firstKey).toMatch(/^[0-9a-f]{64}$/)
})
