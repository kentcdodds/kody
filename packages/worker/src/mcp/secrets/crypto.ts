import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'

const ivBytes = 12

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const derivedEncryptionKeyCache = new Map<string, Promise<CryptoKey>>()

function deriveEncryptionKey(secret: string, purpose: string) {
	const cacheKey = `${purpose}:${secret}`
	const cached = derivedEncryptionKeyCache.get(cacheKey)
	if (cached) return cached

	const derivationPromise = crypto.subtle
		.digest('SHA-256', textEncoder.encode(`${purpose}:${secret}`))
		.then((digest) =>
			crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
				'encrypt',
				'decrypt',
			]),
		)
		.catch((error) => {
			derivedEncryptionKeyCache.delete(cacheKey)
			throw error
		})
	derivedEncryptionKeyCache.set(cacheKey, derivationPromise)
	return derivationPromise
}

export async function encryptStringWithPurpose(
	env: Pick<Env, 'COOKIE_SECRET'>,
	purpose: string,
	value: string,
) {
	const key = await deriveEncryptionKey(env.COOKIE_SECRET, purpose)
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		key,
		textEncoder.encode(value),
	)
	return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`
}

export async function decryptStringWithPurpose(
	env: Pick<Env, 'COOKIE_SECRET'>,
	purpose: string,
	payload: string,
) {
	const [ivPart, ciphertextPart] = payload.split('.')
	if (!ivPart || !ciphertextPart) {
		throw new Error('Invalid encrypted secret payload.')
	}
	const key = await deriveEncryptionKey(env.COOKIE_SECRET, purpose)
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: base64UrlToBytes(ivPart),
		},
		key,
		base64UrlToBytes(ciphertextPart),
	)
	return textDecoder.decode(plaintext)
}

const secretStorePurpose = 'mcp-secret-store'

export async function encryptSecretValue(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
) {
	const key = await deriveEncryptionKey(
		env.SECRET_STORE_KEY,
		secretStorePurpose,
	)
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		textEncoder.encode(value),
	)
	return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`
}

export async function decryptSecretValue(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
) {
	const [ivPart, ciphertextPart] = payload.split('.')
	if (!ivPart || !ciphertextPart) {
		throw new Error('Invalid encrypted secret payload.')
	}
	try {
		const iv = base64UrlToBytes(ivPart)
		const ciphertextBytes = base64UrlToBytes(ciphertextPart)
		const key = await deriveEncryptionKey(
			env.SECRET_STORE_KEY,
			secretStorePurpose,
		)
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertextBytes,
		)
		return textDecoder.decode(plaintext)
	} catch {
		throw new Error('Unable to decrypt secret value.')
	}
}
