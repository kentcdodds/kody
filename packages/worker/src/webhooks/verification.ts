import { decryptSecretValue, encryptSecretValue } from '#mcp/secrets/crypto.ts'
import {
	type PublicWebhookVerificationConfig,
	type StoredWebhookVerificationConfig,
	type WebhookHmacAlgorithm,
	type WebhookSignatureEncoding,
	type WebhookVerificationInput,
} from './types.ts'

const hmacAlgorithms = new Set<WebhookHmacAlgorithm>([
	'hmac-sha256',
	'hmac-sha1',
])
const encodings = new Set<WebhookSignatureEncoding>(['hex', 'base64'])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseWebhookVerificationInput(
	value: unknown,
): WebhookVerificationInput {
	if (!isRecord(value)) {
		throw new Error('verification must be an object.')
	}
	const type = value.type
	if (
		typeof type !== 'string' ||
		!hmacAlgorithms.has(type as WebhookHmacAlgorithm)
	) {
		throw new Error('verification.type must be hmac-sha256 or hmac-sha1.')
	}
	const header = typeof value.header === 'string' ? value.header.trim() : ''
	if (!header) {
		throw new Error('verification.header is required.')
	}
	const secret = typeof value.secret === 'string' ? value.secret : ''
	if (!secret) {
		throw new Error('verification.secret is required.')
	}
	const encoding = value.encoding
	if (
		typeof encoding !== 'string' ||
		!encodings.has(encoding as WebhookSignatureEncoding)
	) {
		throw new Error('verification.encoding must be hex or base64.')
	}
	const prefix =
		value.prefix === undefined
			? undefined
			: typeof value.prefix === 'string'
				? value.prefix
				: null
	if (prefix === null) {
		throw new Error('verification.prefix must be a string when provided.')
	}
	return {
		type: type as WebhookHmacAlgorithm,
		header,
		secret,
		encoding: encoding as WebhookSignatureEncoding,
		...(prefix !== undefined ? { prefix } : {}),
	}
}

export async function encryptWebhookVerificationConfig(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	input: WebhookVerificationInput,
): Promise<StoredWebhookVerificationConfig> {
	return {
		type: input.type,
		header: input.header,
		encoding: input.encoding,
		...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
		encryptedSecret: await encryptSecretValue(env, input.secret),
	}
}

export function serializeStoredWebhookVerificationConfig(
	config: StoredWebhookVerificationConfig,
) {
	return JSON.stringify(config)
}

export function parseStoredWebhookVerificationConfig(
	raw: string | null,
): StoredWebhookVerificationConfig | null {
	if (!raw) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw) as unknown
	} catch {
		return null
	}
	if (!isRecord(parsed)) return null
	const type = parsed.type
	const header = parsed.header
	const encoding = parsed.encoding
	const encryptedSecret = parsed.encryptedSecret
	if (
		typeof type !== 'string' ||
		!hmacAlgorithms.has(type as WebhookHmacAlgorithm) ||
		typeof header !== 'string' ||
		typeof encoding !== 'string' ||
		!encodings.has(encoding as WebhookSignatureEncoding) ||
		typeof encryptedSecret !== 'string'
	) {
		return null
	}
	const prefix =
		parsed.prefix === undefined
			? undefined
			: typeof parsed.prefix === 'string'
				? parsed.prefix
				: undefined
	return {
		type: type as WebhookHmacAlgorithm,
		header,
		encoding: encoding as WebhookSignatureEncoding,
		encryptedSecret,
		...(prefix !== undefined ? { prefix } : {}),
	}
}

export function toPublicWebhookVerificationConfig(
	config: StoredWebhookVerificationConfig | null,
): PublicWebhookVerificationConfig | null {
	if (!config) return null
	return {
		type: config.type,
		header: config.header,
		encoding: config.encoding,
		...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
	}
}

export async function decryptWebhookVerificationSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	config: StoredWebhookVerificationConfig,
) {
	return decryptSecretValue(env, config.encryptedSecret)
}
