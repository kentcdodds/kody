import { expect, test } from 'vitest'
import {
	computeWebhookHmacSignature,
	generateWebhookUrlSecret,
	hashWebhookUrlSecret,
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
