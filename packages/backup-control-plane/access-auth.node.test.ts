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

function futurePayload(
	env = environment(),
	overrides: Record<string, unknown> = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return {
		iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
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
	const jwt = sign({ alg: 'RS256', kid }, futurePayload(env))
	const identity = await verifyAccessJwt(
		env,
		new Request('https://backup.example/', {
			headers: { 'cf-access-jwt-assertion': jwt },
		}),
		async () => Response.json(jwks),
	)
	assert.equal(identity.email, 'ops@example.com')
})

test('verifyAccessJwt rejects wrong aud, email, iss, expiry, signature, and missing header', async () => {
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
		futurePayload(env, { aud: 'other-aud' }),
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

	const wrongIss = sign(
		{ alg: 'RS256', kid },
		futurePayload(env, { iss: 'https://other.example' }),
	)
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': wrongIss },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-iss-mismatch',
	)

	const wrongEmail = sign(
		{ alg: 'RS256', kid },
		futurePayload(env, { email: 'other@example.com' }),
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
		futurePayload(env, { exp: Math.floor(Date.now() / 1000) - 120 }),
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

	const valid = sign({ alg: 'RS256', kid }, futurePayload(env))
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

test('unknown kid refreshes once and JWKS fetch failures use structured errors', async () => {
	resetAccessJwksCacheForTests()
	const env = environment()
	let fetches = 0
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
	})
	const knownKid = 'known-kid'
	const jwk = publicKey.export({ format: 'jwk' })
	const jwksWithKnown = {
		keys: [{ ...jwk, kid: knownKid, alg: 'RS256', use: 'sig' }],
	}
	const signUnknown = (payload: Record<string, unknown>) => {
		const encoded = `${encodeJwtPartForTests({ alg: 'RS256', kid: 'missing-kid' })}.${encodeJwtPartForTests(payload)}`
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
	}
	const jwt = signUnknown(futurePayload(env))
	const fetcher = async () => {
		fetches += 1
		return Response.json(jwksWithKnown)
	}

	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': jwt },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-unknown-kid',
	)
	assert.equal(fetches, 2) // initial cache fill + one forced refresh

	const fetchesAfterFirst = fetches
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': jwt },
			}),
			fetcher,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwt-unknown-kid',
	)
	assert.equal(fetches, fetchesAfterFirst) // cooldown: no additional JWKS fetch

	resetAccessJwksCacheForTests()
	const { kid, sign } = rsaJwksAndSigner()
	const validKidJwt = sign({ alg: 'RS256', kid }, futurePayload(env))
	const abortError = new DOMException('The operation was aborted', 'AbortError')
	await assert.rejects(
		verifyAccessJwt(
			env,
			new Request('https://backup.example/', {
				headers: { 'cf-access-jwt-assertion': validKidJwt },
			}),
			async () => {
				throw abortError
			},
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'access-jwks-fetch-failed',
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
