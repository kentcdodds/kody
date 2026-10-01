import { expect, test } from 'vitest'
import {
	parseCapabilityProxyAuthenticatedFetchArgs,
	serializeAuthenticatedFetchResponse,
	capabilityProxyAuthenticatedFetchMaxBodyBytes,
} from './capability-proxy-authenticated-fetch.ts'
import { ApiError } from './errors.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

test('parseCapabilityProxyAuthenticatedFetchArgs accepts a valid request', () => {
	expect(
		parseCapabilityProxyAuthenticatedFetchArgs([
			{
				providerName: 'google',
				request: {
					url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
					method: 'GET',
					headers: { accept: 'application/json' },
					body: undefined,
				},
			},
		]),
	).toEqual({
		providerName: 'google',
		request: {
			url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
			method: 'GET',
			headers: { accept: 'application/json' },
		},
	})
})

test('parseCapabilityProxyAuthenticatedFetchArgs rejects oversized bodies', () => {
	const body = 'x'.repeat(capabilityProxyAuthenticatedFetchMaxBodyBytes + 1)
	expect(() =>
		parseCapabilityProxyAuthenticatedFetchArgs([
			{
				providerName: 'google',
				request: { url: 'https://example.com/', body },
			},
		]),
	).toThrow(ApiError)
})

test('serializeAuthenticatedFetchResponse base64-encodes the body', async () => {
	const body = new TextEncoder().encode('hello')
	const serialized = await serializeAuthenticatedFetchResponse(
		new Response(body, {
			status: 201,
			statusText: 'Created',
			headers: { 'x-test': '1' },
		}),
	)
	expect(serialized).toEqual({
		status: 201,
		statusText: 'Created',
		headers: { 'x-test': '1' },
		bodyBase64: bytesToBase64(body),
	})
})

test('serializeAuthenticatedFetchResponse rejects oversized responses', async () => {
	const body = new Uint8Array(capabilityProxyAuthenticatedFetchMaxBodyBytes + 1)
	await expect(
		serializeAuthenticatedFetchResponse(new Response(body)),
	).rejects.toBeInstanceOf(ApiError)
})
