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

async function deriveEncryptionKey(cookieSecret: string, purpose: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(`${purpose}:${cookieSecret}`),
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
	env: Pick<Env, 'COOKIE_SECRET'>,
	value: string,
) {
	return encryptStringWithPurpose(env, secretStorePurpose, value)
}

export async function decryptSecretValue(
	env: Pick<Env, 'COOKIE_SECRET'>,
	payload: string,
) {
	return decryptStringWithPurpose(env, secretStorePurpose, payload)
}
