import { expect, test } from 'vitest'
import {
	collectWebhookCredentialSecrets,
	redactWebhookCredentials,
} from './redact.ts'

test('collectWebhookCredentialSecrets includes percent-encoded variants', () => {
	const url = 'https://hooks.example/u/whsec_abc123'
	const urlSecret = 'whsec_abc123'
	const secrets = collectWebhookCredentialSecrets({ url, urlSecret })
	expect(secrets).toContain(url)
	expect(secrets).toContain(urlSecret)
	expect(secrets).toContain(encodeURIComponent(url))
})

test('redactWebhookCredentials removes percent-encoded callback URLs', () => {
	const url = 'https://hooks.example/u/whsec_abc123'
	const secrets = collectWebhookCredentialSecrets({
		url,
		urlSecret: 'whsec_abc123',
	})
	const remoteError = `callback rejected: ${encodeURIComponent(url)}`
	const redacted = redactWebhookCredentials(remoteError, secrets)
	expect(redacted).toBeTypeOf('string')
	expect(redacted as string).not.toContain(url)
	expect(redacted as string).not.toContain(encodeURIComponent(url))
	expect(redacted as string).toContain('[redacted]')
})
