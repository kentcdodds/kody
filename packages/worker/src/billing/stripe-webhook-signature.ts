/**
 * Stripe webhook signature verification (no SDK).
 *
 * Matches the algorithm used by Stripe's official libraries: HMAC-SHA256 of
 * `${t}.${rawBody}` keyed by the endpoint signing secret string (including the
 * `whsec_` prefix), compared against each `v1` signature in `Stripe-Signature`.
 * Timestamps older than the tolerance window are rejected.
 *
 * @see https://docs.stripe.com/webhooks#verify-manually
 */
import { toHex } from '@kody-internal/shared/hex.ts'
import { timingSafeEqualString } from '#worker/maintenance-handler.ts'

export const stripeWebhookDefaultToleranceSeconds = 300

export class StripeWebhookSignatureError extends Error {
	readonly code:
		| 'missing_header'
		| 'invalid_header'
		| 'no_v1_signatures'
		| 'signature_mismatch'
		| 'timestamp_tolerance'

	constructor(code: StripeWebhookSignatureError['code'], message: string) {
		super(message)
		this.name = 'StripeWebhookSignatureError'
		this.code = code
	}
}

function parseStripeSignatureHeader(header: string): {
	timestamp: number
	v1Signatures: Array<string>
} | null {
	let timestamp = -1
	const v1Signatures: Array<string> = []
	for (const part of header.split(',')) {
		const separator = part.indexOf('=')
		if (separator <= 0) continue
		const key = part.slice(0, separator).trim()
		const value = part.slice(separator + 1).trim()
		if (!value) continue
		if (key === 't') {
			const parsed = Number.parseInt(value, 10)
			if (Number.isFinite(parsed)) timestamp = parsed
			continue
		}
		if (key === 'v1') {
			v1Signatures.push(value)
		}
	}
	if (timestamp < 0) return null
	return { timestamp, v1Signatures }
}

export async function computeStripeWebhookSignature(input: {
	secret: string
	timestamp: number
	rawBody: string
}): Promise<string> {
	// Stripe endpoint secrets are UTF-8 key material, including the `whsec_`
	// prefix — matching Stripe's official libraries.
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.secret.trim()),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signedPayload = `${input.timestamp}.${input.rawBody}`
	const digest = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(signedPayload),
	)
	return toHex(new Uint8Array(digest))
}

export async function verifyStripeWebhookSignature(input: {
	secret: string
	signatureHeader: string | null | undefined
	rawBody: string
	toleranceSeconds?: number
	nowSeconds?: number
}): Promise<{ timestamp: number }> {
	const header = input.signatureHeader?.trim()
	if (!header) {
		throw new StripeWebhookSignatureError(
			'missing_header',
			'Missing Stripe-Signature header.',
		)
	}

	const parsed = parseStripeSignatureHeader(header)
	if (!parsed) {
		throw new StripeWebhookSignatureError(
			'invalid_header',
			'Unable to extract timestamp from Stripe-Signature header.',
		)
	}
	if (parsed.v1Signatures.length === 0) {
		throw new StripeWebhookSignatureError(
			'no_v1_signatures',
			'No v1 signatures found in Stripe-Signature header.',
		)
	}

	const expected = await computeStripeWebhookSignature({
		secret: input.secret,
		timestamp: parsed.timestamp,
		rawBody: input.rawBody,
	})

	let matched = false
	for (const candidate of parsed.v1Signatures) {
		if (await timingSafeEqualString(expected, candidate)) {
			matched = true
			break
		}
	}
	if (!matched) {
		throw new StripeWebhookSignatureError(
			'signature_mismatch',
			'No Stripe-Signature v1 value matched the expected HMAC.',
		)
	}

	const tolerance =
		input.toleranceSeconds ?? stripeWebhookDefaultToleranceSeconds
	const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	if (tolerance > 0 && Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
		throw new StripeWebhookSignatureError(
			'timestamp_tolerance',
			'Stripe-Signature timestamp is outside the allowed tolerance.',
		)
	}

	return { timestamp: parsed.timestamp }
}

export async function buildStripeWebhookSignatureHeader(input: {
	secret: string
	rawBody: string
	timestamp?: number
}): Promise<string> {
	const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
	const signature = await computeStripeWebhookSignature({
		secret: input.secret,
		timestamp,
		rawBody: input.rawBody,
	})
	return `t=${timestamp},v1=${signature}`
}
