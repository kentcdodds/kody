import {
	constants,
	createHmac,
	createVerify,
	generateKeyPairSync,
	timingSafeEqual,
	verify,
} from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createMissingSecretMessage } from '#mcp/secrets/errors.ts'
import * as secretService from '#mcp/secrets/service.ts'
import { jwtSignCapability } from './jwt-sign.ts'
import { decodeHmacKeyMaterial, extractSecretMaterial } from './jwt-signing.ts'

function createKeyPair() {
	return generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem',
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem',
		},
	})
}

function decodeJwtPart(value: string) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64.padEnd(
		base64.length + ((4 - (base64.length % 4)) % 4),
		'=',
	)
	return JSON.parse(
		Buffer.from(padded, 'base64url').toString('utf8'),
	) as Record<string, unknown>
}

test('secretJwtSign resolves keys and never leaks key material', async () => {
	const { privateKey, publicKey } = createKeyPair()
	const resolveSecretSpy = vi.spyOn(secretService, 'resolveSecret')
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const env = {} as Env

	try {
		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})

		const signed = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'serviceAccountKey',
				algorithm: 'RS256',
				header: { kid: 'key-1' },
				claims: {
					iss: 'service@example.com',
					sub: 'user@example.com',
					aud: 'https://example.com/token',
					iat: 1,
					exp: 3601,
				},
			},
			{ env, callerContext },
		)
		const [encodedHeader, encodedClaims, encodedSignature] =
			signed.jwt.split('.')
		expect(encodedHeader).toBeTruthy()
		expect(encodedClaims).toBeTruthy()
		expect(encodedSignature).toBeTruthy()
		expect(signed.algorithm).toBe('RS256')
		expect(decodeJwtPart(encodedHeader ?? '')).toMatchObject({
			alg: 'RS256',
			typ: 'JWT',
			kid: 'key-1',
		})
		expect(decodeJwtPart(encodedClaims ?? '')).toMatchObject({
			iss: 'service@example.com',
			sub: 'user@example.com',
		})
		const verifier = createVerify('RSA-SHA256')
		verifier.update(`${encodedHeader}.${encodedClaims}`)
		verifier.end()
		expect(
			verifier.verify(
				publicKey,
				Buffer.from(encodedSignature ?? '', 'base64url'),
			),
		).toBe(true)
		expect(signed.jwt).not.toContain('PRIVATE KEY')

		const ed25519 = generateKeyPairSync('ed25519', {
			publicKeyEncoding: {
				type: 'spki',
				format: 'pem',
			},
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'pem',
			},
		})
		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: ed25519.privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		const edSigned = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'originAppPrivateKey',
				algorithm: 'EdDSA',
				header: { kid: 'app_01example' },
				claims: {
					iss: 'app_01example',
					aud: 'origin-apps',
					iat: 1,
					exp: 301,
				},
			},
			{ env, callerContext },
		)
		const [edHeader, edClaims, edSignature] = edSigned.jwt.split('.')
		expect(edSigned.algorithm).toBe('EdDSA')
		expect(decodeJwtPart(edHeader ?? '')).toMatchObject({
			alg: 'EdDSA',
			typ: 'JWT',
			kid: 'app_01example',
		})
		expect(decodeJwtPart(edClaims ?? '')).toEqual({
			iss: 'app_01example',
			aud: 'origin-apps',
			iat: 1,
			exp: 301,
		})
		expect(
			verify(
				null,
				Buffer.from(`${edHeader}.${edClaims}`),
				ed25519.publicKey,
				Buffer.from(edSignature ?? '', 'base64url'),
			),
		).toBe(true)
		expect(edSigned.jwt).not.toContain(ed25519.privateKey)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: JSON.stringify({
				client_email: 'service@example.com',
				private_key: privateKey,
			}),
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		const jsonSigned = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'serviceAccountJson',
				private_key_json_field: 'private_key',
				algorithm: 'RS256',
				claims: { iss: 'service@example.com' },
			},
			{ env, callerContext },
		)
		expect(jsonSigned.jwt.split('.')).toHaveLength(3)

		resolveSecretSpy.mockResolvedValue({
			found: false,
			value: null,
			scope: null,
			allowedHosts: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'missingKey',
					algorithm: 'RS256',
					claims: { iss: 'service@example.com' },
				},
				{ env, callerContext },
			),
		).rejects.toThrow(createMissingSecretMessage('missingKey'))

		expect(() =>
			extractSecretMaterial({
				secretValue: JSON.stringify({ private_key: 'super-secret-key' }),
				jsonField: 'missing_key',
			}),
		).toThrow(
			'Signing key secret JSON field "missing_key" must be a non-empty string.',
		)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

function jwtSigningInput(jwt: string) {
	const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.')
	return {
		data: `${encodedHeader}.${encodedClaims}`,
		signature: Buffer.from(encodedSignature ?? '', 'base64url'),
	}
}

function verifyHmacJwt(
	jwt: string,
	keyBytes: Uint8Array,
	hash: 'sha256' | 'sha384' | 'sha512',
) {
	const { data, signature } = jwtSigningInput(jwt)
	const expected = createHmac(hash, keyBytes).update(data).digest()
	return (
		expected.length === signature.length && timingSafeEqual(expected, signature)
	)
}

function createEcKeyPair(namedCurve: 'prime256v1' | 'secp384r1' | 'secp521r1') {
	return generateKeyPairSync('ec', {
		namedCurve,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem',
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem',
		},
	})
}

test('secretJwtSign signs HMAC JWTs from encoded secrets', async () => {
	const hmacKey = Buffer.from('doordash-test-signing-key-32b!!')
	const utf8Secret = 'door-dash-utf8-hmac-secret'
	const resolveSecretSpy = vi.spyOn(secretService, 'resolveSecret')
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const env = {} as Env
	const doorDashClaims = {
		aud: 'doordash',
		iss: 'developer-id',
		kid: 'key-id',
		iat: 1,
		exp: 301,
	}

	try {
		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: hmacKey.toString('base64'),
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})

		const signed = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'doorDashSigningSecret',
				algorithm: 'HS256',
				header: { 'dd-ver': 'DD-JWT-V1' },
				claims: doorDashClaims,
			},
			{ env, callerContext },
		)
		const [encodedHeader, encodedClaims, encodedSignature] =
			signed.jwt.split('.')
		expect(encodedHeader).toBeTruthy()
		expect(encodedClaims).toBeTruthy()
		expect(encodedSignature).toBeTruthy()
		expect(signed.algorithm).toBe('HS256')
		expect(decodeJwtPart(encodedHeader ?? '')).toEqual({
			alg: 'HS256',
			typ: 'JWT',
			'dd-ver': 'DD-JWT-V1',
		})
		expect(decodeJwtPart(encodedClaims ?? '')).toEqual(doorDashClaims)
		expect(verifyHmacJwt(signed.jwt, hmacKey, 'sha256')).toBe(true)
		expect(signed.jwt).not.toContain(hmacKey.toString('base64'))
		expect(signed.jwt).not.toContain(hmacKey.toString('utf8'))

		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'doorDashSigningSecret',
					algorithm: 'HS256',
					header: { alg: 'RS256' },
					claims: doorDashClaims,
				},
				{ env, callerContext },
			),
		).rejects.toThrow('JWT header alg must match the requested algorithm.')

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: utf8Secret,
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		const utf8Signed = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'utf8HmacSecret',
				algorithm: 'HS384',
				key_encoding: 'utf8',
				claims: { aud: 'example' },
			},
			{ env, callerContext },
		)
		expect(utf8Signed.algorithm).toBe('HS384')
		expect(decodeJwtPart(utf8Signed.jwt.split('.')[0] ?? '')).toMatchObject({
			alg: 'HS384',
		})
		expect(
			verifyHmacJwt(utf8Signed.jwt, Buffer.from(utf8Secret, 'utf8'), 'sha384'),
		).toBe(true)
		expect(utf8Signed.jwt).not.toContain(utf8Secret)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: hmacKey.toString('base64url'),
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		const base64urlSigned = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'base64urlHmacSecret',
				algorithm: 'HS512',
				key_encoding: 'base64url',
				claims: { aud: 'example' },
			},
			{ env, callerContext },
		)
		expect(base64urlSigned.algorithm).toBe('HS512')
		expect(verifyHmacJwt(base64urlSigned.jwt, hmacKey, 'sha512')).toBe(true)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: JSON.stringify({ signing_secret: hmacKey.toString('base64') }),
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		const jsonSigned = await jwtSignCapability.handler(
			{
				private_key_secret_name: 'doorDashJson',
				private_key_json_field: 'signing_secret',
				algorithm: 'HS256',
				claims: { aud: 'doordash' },
			},
			{ env, callerContext },
		)
		expect(verifyHmacJwt(jsonSigned.jwt, hmacKey, 'sha256')).toBe(true)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: '%%%not-valid-base64%%%',
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		const invalidBase64 = '%%%not-valid-base64%%%'
		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'badBase64Secret',
					algorithm: 'HS256',
					claims: { aud: 'doordash' },
				},
				{ env, callerContext },
			),
		).rejects.toSatisfy((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error)
			return (
				message.includes('HMAC signing key secret is not valid base64.') &&
				!message.includes(invalidBase64)
			)
		})

		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'badBase64Secret',
					algorithm: 'HS256',
					key_encoding: 'hex',
					claims: { aud: 'doordash' },
				} as never,
				{ env, callerContext },
			),
		).rejects.toSatisfy((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error)
			return (
				message.includes('Invalid input for capability "secretJwtSign"') &&
				!message.includes(invalidBase64)
			)
		})

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: hmacKey.toString('base64'),
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'rsaKey',
					algorithm: 'RS256',
					key_encoding: 'base64',
					claims: { iss: 'service@example.com' },
				},
				{ env, callerContext },
			),
		).rejects.toThrow(
			'key_encoding is only valid when algorithm is HS256, HS384, or HS512.',
		)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: invalidBase64,
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'badBase64UrlSecret',
					algorithm: 'HS256',
					key_encoding: 'base64url',
					claims: { aud: 'doordash' },
				},
				{ env, callerContext },
			),
		).rejects.toThrow('HMAC signing key secret is not valid base64url.')

		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'doorDashSigningSecret',
					algorithm: 'none',
					claims: { aud: 'doordash' },
				} as never,
				{ env, callerContext },
			),
		).rejects.toThrow(/Invalid input for capability "secretJwtSign"/)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('secretJwtSign signs RS, PS, and ES JWTs from PKCS#8 PEM secrets', async () => {
	const rsa = createKeyPair()
	const p256 = createEcKeyPair('prime256v1')
	const p384 = createEcKeyPair('secp384r1')
	const p521 = createEcKeyPair('secp521r1')
	const resolveSecretSpy = vi.spyOn(secretService, 'resolveSecret')
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const env = {} as Env
	const claims = { iss: 'service@example.com', aud: 'example' }

	async function signWithPem(
		privateKey: string,
		algorithm: 'RS384' | 'RS512' | 'PS256' | 'ES256' | 'ES384' | 'ES512',
	) {
		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		return jwtSignCapability.handler(
			{
				private_key_secret_name: 'signingKey',
				algorithm,
				claims,
			},
			{ env, callerContext },
		)
	}

	try {
		const rs384 = await signWithPem(rsa.privateKey, 'RS384')
		const rs384Parts = jwtSigningInput(rs384.jwt)
		const rs384Verifier = createVerify('RSA-SHA384')
		rs384Verifier.update(rs384Parts.data)
		rs384Verifier.end()
		expect(rs384.algorithm).toBe('RS384')
		expect(decodeJwtPart(rs384.jwt.split('.')[0] ?? '')).toMatchObject({
			alg: 'RS384',
		})
		expect(rs384Verifier.verify(rsa.publicKey, rs384Parts.signature)).toBe(true)
		expect(rs384.jwt).not.toContain('PRIVATE KEY')

		const rs512 = await signWithPem(rsa.privateKey, 'RS512')
		const rs512Parts = jwtSigningInput(rs512.jwt)
		const rs512Verifier = createVerify('RSA-SHA512')
		rs512Verifier.update(rs512Parts.data)
		rs512Verifier.end()
		expect(rs512Verifier.verify(rsa.publicKey, rs512Parts.signature)).toBe(true)

		const ps256 = await signWithPem(rsa.privateKey, 'PS256')
		const ps256Parts = jwtSigningInput(ps256.jwt)
		expect(ps256.algorithm).toBe('PS256')
		expect(
			verify(
				'sha256',
				Buffer.from(ps256Parts.data),
				{
					key: rsa.publicKey,
					padding: constants.RSA_PKCS1_PSS_PADDING,
					saltLength: 32,
				},
				ps256Parts.signature,
			),
		).toBe(true)

		const es256 = await signWithPem(p256.privateKey, 'ES256')
		const es256Parts = jwtSigningInput(es256.jwt)
		expect(es256.algorithm).toBe('ES256')
		expect(
			verify(
				'sha256',
				Buffer.from(es256Parts.data),
				{ key: p256.publicKey, dsaEncoding: 'ieee-p1363' },
				es256Parts.signature,
			),
		).toBe(true)

		const es384 = await signWithPem(p384.privateKey, 'ES384')
		const es384Parts = jwtSigningInput(es384.jwt)
		expect(
			verify(
				'sha384',
				Buffer.from(es384Parts.data),
				{ key: p384.publicKey, dsaEncoding: 'ieee-p1363' },
				es384Parts.signature,
			),
		).toBe(true)

		const es512 = await signWithPem(p521.privateKey, 'ES512')
		const es512Parts = jwtSigningInput(es512.jwt)
		expect(
			verify(
				'sha512',
				Buffer.from(es512Parts.data),
				{ key: p521.publicKey, dsaEncoding: 'ieee-p1363' },
				es512Parts.signature,
			),
		).toBe(true)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: p256.privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					private_key_secret_name: 'signingKey',
					algorithm: 'ES256',
					key_encoding: 'utf8',
					claims,
				},
				{ env, callerContext },
			),
		).rejects.toThrow(
			'key_encoding is only valid when algorithm is HS256, HS384, or HS512.',
		)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('decodeHmacKeyMaterial accepts encodings and rejects invalid input without leaking the key', () => {
	const hmacKey = Buffer.from('doordash-test-signing-key-32b!!')
	expect(
		Buffer.from(
			decodeHmacKeyMaterial({
				secretValue: hmacKey.toString('base64'),
				encoding: 'base64',
			}),
		),
	).toEqual(hmacKey)
	expect(
		Buffer.from(
			decodeHmacKeyMaterial({
				secretValue: ` ${hmacKey.toString('base64')}\n`,
				encoding: 'base64',
			}),
		),
	).toEqual(hmacKey)
	expect(
		Buffer.from(
			decodeHmacKeyMaterial({
				secretValue: hmacKey.toString('base64url'),
				encoding: 'base64url',
			}),
		),
	).toEqual(hmacKey)
	expect(
		Buffer.from(
			decodeHmacKeyMaterial({
				secretValue: 'plain-hmac-secret',
				encoding: 'utf8',
			}),
		),
	).toEqual(Buffer.from('plain-hmac-secret'))

	const invalid = '%%%not-valid-base64%%%'
	expect(() =>
		decodeHmacKeyMaterial({ secretValue: invalid, encoding: 'base64' }),
	).toThrow('HMAC signing key secret is not valid base64.')
	expect(() =>
		decodeHmacKeyMaterial({ secretValue: invalid, encoding: 'base64url' }),
	).toThrow('HMAC signing key secret is not valid base64url.')
	expect(() =>
		decodeHmacKeyMaterial({ secretValue: '', encoding: 'utf8' }),
	).toThrow('HMAC signing key secret must be a non-empty string.')
	try {
		decodeHmacKeyMaterial({ secretValue: invalid, encoding: 'base64' })
		throw new Error('expected decodeHmacKeyMaterial to throw')
	} catch (error) {
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).not.toContain(invalid)
	}
})
