import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'

/**
 * Standard Webhooks symmetric signing for MCP event deliveries:
 * `webhook-signature: v1,<base64(HMAC-SHA256(key, id.timestamp.body))>` where
 * `key` is the base64-decoded remainder of a `whsec_` secret.
 * https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */

const secretPrefix = 'whsec_'
const minSecretBytes = 24
const maxSecretBytes = 64
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/

export class InvalidWebhookSecretError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'InvalidWebhookSecretError'
	}
}

/**
 * Decode a `whsec_` secret to its key bytes. Throws
 * {@link InvalidWebhookSecretError} for any value the draft requires servers
 * to reject with InvalidParams.
 */
export function decodeWebhookSecret(secret: string): Uint8Array<ArrayBuffer> {
	if (!secret.startsWith(secretPrefix)) {
		throw new InvalidWebhookSecretError(
			`delivery.secret must start with "${secretPrefix}".`,
		)
	}
	const encoded = secret.slice(secretPrefix.length)
	if (!base64Pattern.test(encoded) || encoded.length % 4 !== 0) {
		throw new InvalidWebhookSecretError(
			'delivery.secret must be "whsec_" followed by standard base64.',
		)
	}
	let bytes: Uint8Array<ArrayBuffer>
	try {
		bytes = base64ToBytes(encoded)
	} catch {
		throw new InvalidWebhookSecretError(
			'delivery.secret must be "whsec_" followed by standard base64.',
		)
	}
	if (bytes.byteLength < minSecretBytes || bytes.byteLength > maxSecretBytes) {
		throw new InvalidWebhookSecretError(
			`delivery.secret must decode to ${minSecretBytes}-${maxSecretBytes} bytes (got ${bytes.byteLength}).`,
		)
	}
	return bytes
}

export async function signWebhookPayload(input: {
	secret: string
	webhookId: string
	timestampSeconds: number
	body: string
}): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		decodeWebhookSecret(input.secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(
			`${input.webhookId}.${input.timestampSeconds}.${input.body}`,
		),
	)
	return `v1,${bytesToBase64(new Uint8Array(signature))}`
}

/**
 * `webhook-signature` header value. Multiple secrets (rotation grace) yield
 * space-delimited signatures; receivers accept if any verifies.
 */
export async function buildWebhookSignatureHeader(input: {
	secrets: ReadonlyArray<string>
	webhookId: string
	timestampSeconds: number
	body: string
}): Promise<string> {
	if (input.secrets.length === 0) {
		throw new Error('At least one webhook signing secret is required.')
	}
	const signatures = await Promise.all(
		input.secrets.map((secret) =>
			signWebhookPayload({
				secret,
				webhookId: input.webhookId,
				timestampSeconds: input.timestampSeconds,
				body: input.body,
			}),
		),
	)
	return signatures.join(' ')
}

export async function buildSignedWebhookHeaders(input: {
	secrets: ReadonlyArray<string>
	webhookId: string
	subscriptionId: string
	body: string
	now?: Date
}): Promise<Record<string, string>> {
	const timestampSeconds = Math.floor(
		(input.now ?? new Date()).getTime() / 1000,
	)
	return {
		'Content-Type': 'application/json',
		'webhook-id': input.webhookId,
		'webhook-timestamp': String(timestampSeconds),
		'webhook-signature': await buildWebhookSignatureHeader({
			secrets: input.secrets,
			webhookId: input.webhookId,
			timestampSeconds,
			body: input.body,
		}),
		'X-MCP-Subscription-Id': input.subscriptionId,
	}
}
