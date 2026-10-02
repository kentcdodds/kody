import { expect, test } from 'vitest'
import { parseCapabilityProxyOauthClientCredentialsArgs } from './capability-proxy-oauth-client-credentials.ts'
import { ApiError } from './errors.ts'

test('parseCapabilityProxyOauthClientCredentialsArgs accepts a valid grant request', () => {
	expect(
		parseCapabilityProxyOauthClientCredentialsArgs([
			{
				tokenUrl: 'https://oauth.example.com/token',
				clientIdSecret: 'client-id',
				clientSecretSecret: 'client-secret',
				authStyle: 'basic',
				body: { audience: 'api' },
				packageId: 'pkg-1',
			},
		]),
	).toEqual({
		tokenUrl: 'https://oauth.example.com/token',
		clientIdSecret: 'client-id',
		clientSecretSecret: 'client-secret',
		authStyle: 'basic',
		body: { audience: 'api' },
		packageId: 'pkg-1',
	})
})

test('parseCapabilityProxyOauthClientCredentialsArgs rejects missing secrets', () => {
	expect(() =>
		parseCapabilityProxyOauthClientCredentialsArgs([
			{ tokenUrl: 'https://oauth.example.com/token', clientIdSecret: 'id' },
		]),
	).toThrow(ApiError)
})

test('parseCapabilityProxyOauthClientCredentialsArgs rejects non-basic authStyle', () => {
	expect(() =>
		parseCapabilityProxyOauthClientCredentialsArgs([
			{
				tokenUrl: 'https://oauth.example.com/token',
				clientIdSecret: 'id',
				clientSecretSecret: 'secret',
				authStyle: 'post',
			},
		]),
	).toThrow(ApiError)
})
