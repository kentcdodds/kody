import { generateKeyPairSync, createVerify } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createCapabilitySecretAccessDeniedMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import * as secretService from '#mcp/secrets/service.ts'
import { jwtSignCapability } from './jwt-sign.ts'
import { extractPrivateKeyPem } from './jwt-signing.ts'

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

test('jwt_sign signs caller-provided claims with an approved secret key', async () => {
	const { privateKey, publicKey } = createKeyPair()
	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: ['jwt_sign'],
			allowedPackages: [],
		})

	try {
		const result = await jwtSignCapability.handler(
			{
				privateKeySecretName: 'serviceAccountKey',
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
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
		)
		const [encodedHeader, encodedClaims, encodedSignature] =
			result.jwt.split('.')
		expect(encodedHeader).toBeTruthy()
		expect(encodedClaims).toBeTruthy()
		expect(encodedSignature).toBeTruthy()
		expect(result.algorithm).toBe('RS256')
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
		expect(result.jwt).not.toContain('PRIVATE KEY')
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('jwt_sign can extract a private key from a JSON secret field', async () => {
	const { privateKey } = createKeyPair()
	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: JSON.stringify({
				client_email: 'service@example.com',
				private_key: privateKey,
			}),
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: ['jwt_sign'],
			allowedPackages: [],
		})

	try {
		const result = await jwtSignCapability.handler(
			{
				privateKeySecretName: 'serviceAccountJson',
				privateKeyJsonField: 'private_key',
				algorithm: 'RS256',
				claims: { iss: 'service@example.com' },
			},
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
		)
		expect(result.jwt.split('.')).toHaveLength(3)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('jwt_sign requires the secret to approve the capability', async () => {
	const { privateKey } = createKeyPair()
	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
		})

	try {
		await expect(
			jwtSignCapability.handler(
				{
					privateKeySecretName: 'serviceAccountKey',
					algorithm: 'RS256',
					claims: { iss: 'service@example.com' },
				},
				{
					env: {} as Env,
					callerContext: createMcpCallerContext({
						baseUrl: 'https://heykody.dev',
						user: { userId: 'user-123' },
					}),
				},
			),
		).rejects.toThrow(
			createCapabilitySecretAccessDeniedMessage(
				'serviceAccountKey',
				'jwt_sign',
				'https://heykody.dev/account/secrets/user/serviceAccountKey?capability=jwt_sign',
			),
		)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('jwt_sign reports missing secrets without leaking key material', async () => {
	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: false,
			value: null,
			scope: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
		})

	try {
		await expect(
			jwtSignCapability.handler(
				{
					privateKeySecretName: 'missingKey',
					algorithm: 'RS256',
					claims: { iss: 'service@example.com' },
				},
				{
					env: {} as Env,
					callerContext: createMcpCallerContext({
						baseUrl: 'https://heykody.dev',
						user: { userId: 'user-123' },
					}),
				},
			),
		).rejects.toThrow(createMissingSecretMessage('missingKey'))
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('extractPrivateKeyPem rejects missing JSON fields without echoing secret', () => {
	expect(() =>
		extractPrivateKeyPem({
			secretValue: JSON.stringify({ private_key: 'super-secret-key' }),
			jsonField: 'missing_key',
		}),
	).toThrow(
		'Private key secret JSON field "missing_key" must be a non-empty string.',
	)
})
