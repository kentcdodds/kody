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

test('jwt_sign resolves keys, enforces secret approval, and never leaks key material', async () => {
	const { privateKey, publicKey } = createKeyPair()
	const resolveSecretSpy = vi.spyOn(secretService, 'resolveSecret')
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const env = {} as Env
	const approvalMessage = createCapabilitySecretAccessDeniedMessage(
		'serviceAccountKey',
		'jwt_sign',
		'https://heykody.dev/account/secrets/user/serviceAccountKey?capability=jwt_sign',
	)

	try {
		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: ['jwt_sign'],
			allowedPackages: [],
		})

		const signed = await jwtSignCapability.handler(
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

		resolveSecretSpy.mockResolvedValue({
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
		const jsonSigned = await jwtSignCapability.handler(
			{
				privateKeySecretName: 'serviceAccountJson',
				privateKeyJsonField: 'private_key',
				algorithm: 'RS256',
				claims: { iss: 'service@example.com' },
			},
			{ env, callerContext },
		)
		expect(jsonSigned.jwt.split('.')).toHaveLength(3)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					privateKeySecretName: 'serviceAccountKey',
					algorithm: 'RS256',
					claims: { iss: 'service@example.com' },
				},
				{ env, callerContext },
			),
		).rejects.toThrow(approvalMessage)

		resolveSecretSpy.mockResolvedValue({
			found: true,
			value: privateKey,
			scope: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					privateKeySecretName: 'serviceAccountKey',
					algorithm: 'RS256',
					claims: { iss: 'service@example.com' },
				},
				{ env, callerContext },
			),
		).rejects.toThrow(approvalMessage)

		resolveSecretSpy.mockResolvedValue({
			found: false,
			value: null,
			scope: null,
			allowedHosts: [],
			allowedCapabilities: [],
			allowedPackages: [],
		})
		await expect(
			jwtSignCapability.handler(
				{
					privateKeySecretName: 'missingKey',
					algorithm: 'RS256',
					claims: { iss: 'service@example.com' },
				},
				{ env, callerContext },
			),
		).rejects.toThrow(createMissingSecretMessage('missingKey'))

		expect(() =>
			extractPrivateKeyPem({
				secretValue: JSON.stringify({ private_key: 'super-secret-key' }),
				jsonField: 'missing_key',
			}),
		).toThrow(
			'Private key secret JSON field "missing_key" must be a non-empty string.',
		)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})
