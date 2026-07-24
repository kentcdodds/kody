import {
	bytesToBase64,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '#worker/maintenance-handler.ts'
import {
	type WebhookHmacAlgorithm,
	type WebhookSignatureEncoding,
} from './types.ts'

const urlSecretBytes = 32

export async function hashWebhookUrlSecret(secret: string) {
	return sha256Hex(secret)
}

export async function generateWebhookUrlSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(urlSecretBytes))
	return bytesToBase64Url(bytes)
}

export async function webhookUrlSecretMatches(input: {
	candidate: string
	storedHash: string
}) {
	const candidateHash = await hashWebhookUrlSecret(input.candidate)
	return timingSafeEqualString(candidateHash, input.storedHash)
}

function hmacHashName(algorithm: WebhookHmacAlgorithm) {
	switch (algorithm) {
		case 'hmac-sha256':
			return 'SHA-256'
		case 'hmac-sha1':
			return 'SHA-1'
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unhandled HMAC algorithm: ${String(exhaustive)}`)
		}
	}
}

function encodeSignature(
	digest: ArrayBuffer,
	encoding: WebhookSignatureEncoding,
) {
	const bytes = new Uint8Array(digest)
	switch (encoding) {
		case 'hex':
			return toHex(bytes)
		case 'base64':
			return bytesToBase64(bytes)
		default: {
			const exhaustive: never = encoding
			throw new Error(`Unhandled signature encoding: ${String(exhaustive)}`)
		}
	}
}

export async function computeWebhookHmacSignature(input: {
	algorithm: WebhookHmacAlgorithm
	secret: string
	body: ArrayBuffer
	encoding: WebhookSignatureEncoding
	prefix?: string
}) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.secret),
		{ name: 'HMAC', hash: hmacHashName(input.algorithm) },
		false,
		['sign'],
	)
	const digest = await crypto.subtle.sign('HMAC', key, input.body)
	const encoded = encodeSignature(digest, input.encoding)
	return input.prefix ? `${input.prefix}${encoded}` : encoded
}

export async function verifyWebhookHmacSignature(input: {
	algorithm: WebhookHmacAlgorithm
	secret: string
	body: ArrayBuffer
	encoding: WebhookSignatureEncoding
	prefix?: string
	provided: string
}) {
	const expected = await computeWebhookHmacSignature({
		algorithm: input.algorithm,
		secret: input.secret,
		body: input.body,
		encoding: input.encoding,
		prefix: input.prefix,
	})
	return timingSafeEqualString(expected, input.provided.trim())
}
