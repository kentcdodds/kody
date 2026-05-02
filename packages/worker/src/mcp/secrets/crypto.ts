const ivBytes = 12

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const value of bytes) {
		binary += String.fromCharCode(value)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

function base64UrlToBytes(value: string) {
	const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
	const padded = normalized.padEnd(
		normalized.length + ((4 - (normalized.length % 4)) % 4),
		'=',
	)
	const binary = atob(padded)
	return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function deriveEncryptionKey(secret: string, purpose: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(`${purpose}:${secret}`),
	)
	return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
		'encrypt',
		'decrypt',
	])
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
	env: Pick<Env, 'COOKIE_SECRET' | 'SECRET_STORE_KEY'>,
	value: string,
) {
	const secret = getSecretStoreKey(env)
	const key = await deriveEncryptionKey(secret, secretStorePurpose)
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		textEncoder.encode(value),
	)
	return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`
}

export async function decryptSecretValue(
	env: Pick<Env, 'COOKIE_SECRET' | 'SECRET_STORE_KEY'>,
	payload: string,
) {
	const [ivPart, ciphertextPart] = payload.split('.')
	if (!ivPart || !ciphertextPart) {
		throw new Error('Invalid encrypted secret payload.')
	}
	const iv = base64UrlToBytes(ivPart)
	const ciphertextBytes = base64UrlToBytes(ciphertextPart)

	const primarySecret = getSecretStoreKey(env)
	const primaryKey = await deriveEncryptionKey(primarySecret, secretStorePurpose)
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			primaryKey,
			ciphertextBytes,
		)
		return { value: textDecoder.decode(plaintext), needsReEncrypt: false }
	} catch {
		// Primary key failed — attempt legacy COOKIE_SECRET fallback
	}

	if (primarySecret === env.COOKIE_SECRET) {
		throw new Error('Unable to decrypt secret value.')
	}

	const legacyKey = await deriveEncryptionKey(
		env.COOKIE_SECRET,
		secretStorePurpose,
	)
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			legacyKey,
			ciphertextBytes,
		)
		return { value: textDecoder.decode(plaintext), needsReEncrypt: true }
	} catch {
		throw new Error('Unable to decrypt secret value.')
	}
}

function getSecretStoreKey(
	env: Pick<Env, 'COOKIE_SECRET' | 'SECRET_STORE_KEY'>,
): string {
	return env.SECRET_STORE_KEY ?? env.COOKIE_SECRET
}
