import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign } from 'node:crypto'

import { test } from 'vitest'

import {
	assertSameOriginMutation,
	encodeJwtPartForTests,
	resetAccessJwksCacheForTests,
	verifyAccessJwt,
} from './access-auth.ts'
import { BackupError } from './backup-policy.ts'
import { environment } from './backup-control-plane-test-support.ts'

function rsaJwksAndSigner() {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
	})
	const jwk = publicKey.export({ format: 'jwk' })
	const kid = 'test-kid-1'
	return {
		kid,
		jwks: {
			keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }],
		},
		sign(header: Record<string, unknown>, payload: Record<string, unknown>) {
			const encoded = `${encodeJwtPartForTests(header)}.${encodeJwtPartForTests(payload)}`
			const signer = createSign('RSA-SHA256')
			signer.update(encoded)
			signer.end()
			const signature = signer
				.sign(privateKey)
				.toString('base64')
				.replaceAll('+', '-')
				.replaceAll('/', '_')
				.replaceAll('=', '')
			return `${encoded}.${signature}`
		},
	}
}

function futurePayload(overrides: Record<string, unknown> = {}) {
	const now = Math.floor(Date.now() / 1000)
	return {
		aud: 'access-app-audience',
		email: 'ops@example.com',
		iat: now - 10,
		exp: now + 3600,
		...overrides,
	}
}

test('verifyAccessJwt accepts a self-signed RS256 Access assertion', async () => {
	resetAccessJwksCacheForTests()
	const { kid, jwks, sign } = rsaJwksAndSigner()
	const env = environment()
	const jwt = sign({ alg: 'RS256', kid }, futurePayload())
	const identity = await verifyAccessJwt(
		env,
		new Request('https://backup.example/', {
			headers: { 'cf-access-jwt-assertion': jwt },
		}),
		async () => Response.json(jwks),
	)
	assert.equal(identity.email, 'ops@example.com')
})

test('verifyAccessJwt rejects wrong aud, email, expiry, signature, and missing header', async () => {
	resetAccessJwksCacheForTests()
	const { kid, jwks, sign } = rsaJwksAndSigner()
	const env = environment()
	const fetcher = async () => Response.json(jwks)

	await assert.rejects(
		verifyAccessJwt(env, new Request('https://backup.example/'), fetcher),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-missing',
	)

	const wrongAud = sign(
		{ alg: 'RS256', kid },
		futurePayload({ aud: 'other-aud' }),
	)
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': wrongAud },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-aud-mismatch',
	)

	const wrongEmail = sign(
		{ alg: 'RS256', kid },
		futurePayload({ email: 'other@example.com' }),
	)
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': wrongEmail },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-email-denied',
	)

	const expired = sign(
		{ alg: 'RS256', kid },
		futurePayload({ exp: Math.floor(Date.now() / 1000) - 120 }),
	)
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': expired },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-expired',
	)

	const valid = sign({ alg: 'RS256', kid }, futurePayload())
	const tampered = `${valid.slice(0, -4)}abcd`
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': tampered },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError &&
			(error.code === 'access-jwt-bad-signature' ||
				error.code === 'access-jwt-malformed'),
	)
})

test('assertSameOriginMutation rejects absent or cross-site Sec-Fetch-Site', () => {
	assert.throws(
		() =>
			assertSameOriginMutation(
				new Request('https://backup.example/actions/run-backup', {
					method: 'POST',
				}),
			),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'csrf-rejected',
	)
	assert.throws(
		() =>
			assertSameOriginMutation(
				new Request('https://backup.example/actions/run-backup', {
					method: 'POST',
					headers: { 'sec-fetch-site': 'none' },
				}),
			),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'csrf-rejected',
	)
	assert.doesNotThrow(() =>
		assertSameOriginMutation(
			new Request('https://backup.example/actions/run-backup', {
				method: 'POST',
				headers: { 'sec-fetch-site': 'same-origin' },
			}),
		),
	)
})
