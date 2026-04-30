import { z } from 'zod'

export const jwtAlgorithmSchema = z.enum(['RS256'])

export type JwtAlgorithm = z.infer<typeof jwtAlgorithmSchema>

export async function signJwt(input: {
	algorithm: JwtAlgorithm
	privateKeyPem: string
	header?: Record<string, unknown>
	claims: Record<string, unknown>
}) {
	const header = buildJwtHeader(input.algorithm, input.header ?? {})
	const signingInput = [
		base64UrlEncodeUtf8(JSON.stringify(header)),
		base64UrlEncodeUtf8(JSON.stringify(input.claims)),
	].join('.')
	const key = await importPrivateKey(input.privateKeyPem, input.algorithm)
	const signature = await crypto.subtle.sign(
		getSigningAlgorithm(input.algorithm),
		key,
		new TextEncoder().encode(signingInput),
	)
	return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`
}

export function extractPrivateKeyPem(input: {
	secretValue: string
	jsonField?: string | null
}) {
	if (!input.jsonField) return input.secretValue
	let parsed: unknown
	try {
		parsed = JSON.parse(input.secretValue)
	} catch {
		throw new Error('Private key secret is not valid JSON.')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Private key secret JSON must be an object.')
	}
	const value = (parsed as Record<string, unknown>)[input.jsonField]
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(
			`Private key secret JSON field "${input.jsonField}" must be a non-empty string.`,
		)
	}
	return value
}

function buildJwtHeader(
	algorithm: JwtAlgorithm,
	header: Record<string, unknown>,
) {
	if (header.alg !== undefined && header.alg !== algorithm) {
		throw new Error('JWT header alg must match the requested algorithm.')
	}
	return {
		typ: 'JWT',
		...header,
		alg: algorithm,
	}
}

async function importPrivateKey(
	privateKeyPem: string,
	algorithm: JwtAlgorithm,
) {
	try {
		return await crypto.subtle.importKey(
			'pkcs8',
			pemToArrayBuffer(privateKeyPem),
			getSigningAlgorithm(algorithm),
			false,
			['sign'],
		)
	} catch {
		throw new Error('Private key secret must contain a valid PKCS#8 PEM key.')
	}
}

function getSigningAlgorithm(algorithm: JwtAlgorithm): RsaHashedImportParams {
	switch (algorithm) {
		case 'RS256':
			return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

function pemToArrayBuffer(pem: string) {
	const base64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/g, '')
		.replace(/-----END PRIVATE KEY-----/g, '')
		.replace(/\s/g, '')
	if (!base64) {
		throw new Error('Private key PEM is empty.')
	}
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes.buffer
}

function base64UrlEncodeUtf8(value: string) {
	return base64UrlEncodeBytes(new TextEncoder().encode(value))
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}
