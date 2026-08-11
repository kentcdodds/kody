import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'

const ivBytes = 12

/**
 * Ciphertext format version. `v2` payloads (`v2.<iv>.<ciphertext>`) bind the
 * AES-GCM ciphertext to an additional-authenticated-data (AAD) string built
 * from the purpose plus an identity context (e.g. the owning user), so a
 * ciphertext copied into another row fails to decrypt. Legacy two-part
 * payloads (`<iv>.<ciphertext>`, no AAD) keep decrypting for compatibility;
 * they upgrade to v2 whenever the value is re-encrypted on write.
 */
const ciphertextVersion = 'v2'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const derivedEncryptionKeyCache = new Map<string, Promise<CryptoKey>>()

function buildAad(purpose: string, context: string) {
	return textEncoder.encode(`kody.${ciphertextVersion}|${purpose}|${context}`)
}

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

async function encryptWithKey(
	keySecret: string,
	purpose: string,
	context: string,
	value: string,
) {
	const key = await deriveEncryptionKey(keySecret, purpose)
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
			additionalData: buildAad(purpose, context),
		},
		key,
		textEncoder.encode(value),
	)
	return `${ciphertextVersion}.${bytesToBase64Url(iv)}.${bytesToBase64Url(
		new Uint8Array(ciphertext),
	)}`
}

async function decryptWithKey(
	keySecret: string,
	purpose: string,
	context: string,
	payload: string,
) {
	const parts = payload.split('.')
	const key = await deriveEncryptionKey(keySecret, purpose)
	if (parts.length === 3) {
		const [version, ivPart, ciphertextPart] = parts
		if (version !== ciphertextVersion || !ivPart || !ciphertextPart) {
			throw new Error('Invalid encrypted secret payload.')
		}
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: base64UrlToBytes(ivPart),
				additionalData: buildAad(purpose, context),
			},
			key,
			base64UrlToBytes(ciphertextPart),
		)
		return textDecoder.decode(plaintext)
	}
	if (parts.length === 2) {
		// Legacy payload written before AAD binding existed.
		const [ivPart, ciphertextPart] = parts
		if (!ivPart || !ciphertextPart) {
			throw new Error('Invalid encrypted secret payload.')
		}
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
	throw new Error('Invalid encrypted secret payload.')
}

/**
 * General-purpose string encryption under COOKIE_SECRET. `context` defaults to
 * empty for identity-free payloads; pass an owning identity whenever the
 * ciphertext lives in a row that could be swapped between owners.
 */
export async function encryptStringWithPurpose(
	env: Pick<Env, 'COOKIE_SECRET'>,
	purpose: string,
	value: string,
	context = '',
) {
	return encryptWithKey(env.COOKIE_SECRET, purpose, context, value)
}

export async function decryptStringWithPurpose(
	env: Pick<Env, 'COOKIE_SECRET'>,
	purpose: string,
	payload: string,
	context = '',
) {
	return decryptWithKey(env.COOKIE_SECRET, purpose, context, payload)
}

const secretStorePurpose = 'mcp-secret-store'

/**
 * Platform OAuth client secrets share the SECRET_STORE_KEY KEK but use a
 * dedicated purpose so their ciphertext is never interchangeable with
 * `secret_entries` payloads. They live outside the user secret store on
 * purpose: nothing in the `{{secret:...}}` placeholder namespace can name
 * them, so sandboxed code has no resolution path to the shared credential.
 */
const platformOauthClientSecretPurpose = 'platform-oauth-client-secret'

/** AAD context for a user-owned secret ciphertext. */
export function userSecretContext(userId: string) {
	return `user:${userId}`
}

/** AAD context for a platform OAuth app client secret ciphertext. */
export function platformOauthAppContext(slug: string) {
	return `app:${slug}`
}

export async function encryptPlatformOauthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		platformOauthClientSecretPurpose,
		context,
		value,
	)
}

export async function decryptPlatformOauthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			platformOauthClientSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt platform client secret.')
	}
}

export async function encryptSecretValue(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		secretStorePurpose,
		context,
		value,
	)
}

export async function decryptSecretValue(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			secretStorePurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt secret value.')
	}
}
