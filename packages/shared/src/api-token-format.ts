import { bytesToBase64Url } from './base64.ts'

/**
 * Wire format for Kody account API tokens: `kody_at_<id>_<secret>`.
 *
 * The id is the `api_tokens` primary key, so authentication is one keyed
 * lookup plus a hash compare (no global hash index). The fixed prefix lets
 * secret scanners and log redaction recognize a token without a lookup.
 */
export const apiTokenPrefix = 'kody_at_'

const apiTokenIdLength = 20
const apiTokenSecretBytes = 32
const apiTokenIdAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'

const apiTokenPattern = /^kody_at_([a-z0-9]{20})_([A-Za-z0-9_-]{43})$/

/** Matches any embedded token (for redaction), not only a whole string. */
export const apiTokenSearchPattern = /kody_at_[a-z0-9]{20}_[A-Za-z0-9_-]{43}/g
export const cliBootstrapCodeSearchPattern =
	/kody_bc_[a-z0-9]{16}_[A-Za-z0-9_-]{32}/g

export type ParsedApiToken = {
	tokenId: string
	secret: string
}

export function parseApiToken(value: string): ParsedApiToken | null {
	const match = apiTokenPattern.exec(value.trim())
	if (!match) return null
	const [, tokenId, secret] = match
	if (!tokenId || !secret) return null
	return { tokenId, secret }
}

export function generateApiTokenId() {
	const bytes = crypto.getRandomValues(new Uint8Array(apiTokenIdLength))
	let id = ''
	for (const byte of bytes) {
		id += apiTokenIdAlphabet[byte % apiTokenIdAlphabet.length]
	}
	return id
}

export function generateApiTokenSecret() {
	return bytesToBase64Url(
		crypto.getRandomValues(new Uint8Array(apiTokenSecretBytes)),
	)
}

export function formatApiToken(input: ParsedApiToken) {
	return `${apiTokenPrefix}${input.tokenId}_${input.secret}`
}

export function redactApiTokens(value: string) {
	return value.replace(apiTokenSearchPattern, `${apiTokenPrefix}[redacted]`)
}

export function redactKodyCredentials(value: string) {
	return redactApiTokens(value).replace(
		cliBootstrapCodeSearchPattern,
		'kody_bc_[redacted]',
	)
}

export function redactKodyCredentialsDeep(value: unknown): unknown {
	if (typeof value === 'string') return redactKodyCredentials(value)
	if (Array.isArray(value)) return value.map(redactKodyCredentialsDeep)
	if (value === null || typeof value !== 'object') return value

	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return value

	const redacted: Record<string, unknown> = Object.create(prototype)
	for (const [key, nestedValue] of Object.entries(value)) {
		Object.defineProperty(redacted, key, {
			configurable: true,
			enumerable: true,
			value: redactKodyCredentialsDeep(nestedValue),
			writable: true,
		})
	}
	return redacted
}

export function readBearerApiToken(authorization: string | null) {
	if (!authorization) return null
	const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization)
	return match?.[1] ?? null
}
