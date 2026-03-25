import { getEnv } from '#app/env.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function base64UrlEncode(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
	const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

async function deriveAesKey(secret: string, purpose: string) {
	const material = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(`kody:aes:${purpose}:${secret}`),
	)
	return crypto.subtle.importKey('raw', material, 'AES-GCM', false, [
		'encrypt',
		'decrypt',
	])
}

async function deriveHmacKey(secret: string, purpose: string) {
	return crypto.subtle.importKey(
		'raw',
		textEncoder.encode(`kody:hmac:${purpose}:${secret}`),
		{
			name: 'HMAC',
			hash: 'SHA-256',
		},
		false,
		['sign', 'verify'],
	)
}

function getRootSecret(env: Env) {
	return getEnv(env).COOKIE_SECRET
}

export async function encryptJson(
	env: Env,
	purpose: string,
	value: unknown,
): Promise<string> {
	const key = await deriveAesKey(getRootSecret(env), purpose)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const plaintext = textEncoder.encode(JSON.stringify(value))
	const encrypted = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		key,
		plaintext,
	)
	return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`
}

export async function decryptJson<T>(
	env: Env,
	purpose: string,
	value: string,
): Promise<T> {
	const [encodedIv, encodedCiphertext] = value.split('.')
	if (!encodedIv || !encodedCiphertext) {
		throw new Error('Invalid encrypted payload format.')
	}
	const key = await deriveAesKey(getRootSecret(env), purpose)
	const decrypted = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: base64UrlDecode(encodedIv),
		},
		key,
		base64UrlDecode(encodedCiphertext),
	)
	return JSON.parse(textDecoder.decode(decrypted)) as T
}

export async function signToken(
	env: Env,
	purpose: string,
	payload: Record<string, unknown>,
) {
	const encodedPayload = base64UrlEncode(
		textEncoder.encode(JSON.stringify(payload)),
	)
	const key = await deriveHmacKey(getRootSecret(env), purpose)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		textEncoder.encode(encodedPayload),
	)
	return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`
}

export async function verifyToken<T extends Record<string, unknown>>(
	env: Env,
	purpose: string,
	token: string,
): Promise<T> {
	const [encodedPayload, encodedSignature] = token.split('.')
	if (!encodedPayload || !encodedSignature) {
		throw new Error('Invalid signed token format.')
	}
	const key = await deriveHmacKey(getRootSecret(env), purpose)
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		base64UrlDecode(encodedSignature),
		textEncoder.encode(encodedPayload),
	)
	if (!valid) {
		throw new Error('Invalid signed token signature.')
	}
	const payload = JSON.parse(
		textDecoder.decode(base64UrlDecode(encodedPayload)),
	) as T
	if (typeof payload['exp'] === 'number' && Date.now() > payload['exp']) {
		throw new Error('Signed token has expired.')
	}
	return payload
}
