import { expect, test } from 'vitest'
import {
	parseCapabilityProxyAuthenticatedFetchArgs,
	serializeAuthenticatedFetchResponse,
	capabilityProxyAuthenticatedFetchMaxBodyBytes,
} from './capability-proxy-authenticated-fetch.ts'
import { ApiError } from './errors.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'

test('parseCapabilityProxyAuthenticatedFetchArgs accepts valid requests and rejects mixed or oversized bodies', () => {
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
	expect(
		parseCapabilityProxyAuthenticatedFetchArgs([
			{
				providerName: 'google',
				packageId: 'pkg-1',
				request: {
					url: 'https://gmail.googleapis.com/upload',
					method: 'POST',
					bodyBase64: bytesToBase64(new TextEncoder().encode('png')),
				},
			},
		]),
	).toEqual({
		providerName: 'google',
		packageId: 'pkg-1',
		request: {
			url: 'https://gmail.googleapis.com/upload',
			method: 'POST',
			bodyBase64: bytesToBase64(new TextEncoder().encode('png')),
		},
	})
	expect(() =>
		parseCapabilityProxyAuthenticatedFetchArgs([
			{
				providerName: 'google',
				request: {
					url: 'https://example.com/',
					body: 'text',
					bodyBase64: bytesToBase64(new Uint8Array([1])),
				},
			},
		]),
	).toThrow(ApiError)
	expect(() =>
		parseCapabilityProxyAuthenticatedFetchArgs([
			{
				providerName: 'google',
				request: {
					url: 'https://example.com/',
					body: 'x'.repeat(capabilityProxyAuthenticatedFetchMaxBodyBytes + 1),
				},
			},
		]),
	).toThrow(ApiError)
})

test('serializeAuthenticatedFetchResponse base64-encodes bodies and rejects oversized responses', async () => {
	const body = new TextEncoder().encode('hello')
	expect(
		await serializeAuthenticatedFetchResponse(
			new Response(body, {
				status: 201,
				statusText: 'Created',
				headers: { 'x-test': '1' },
			}),
		),
	).toEqual({
		status: 201,
		statusText: 'Created',
		headers: { 'x-test': '1' },
		bodyBase64: bytesToBase64(body),
	})
	await expect(
		serializeAuthenticatedFetchResponse(
			new Response(
				new Uint8Array(capabilityProxyAuthenticatedFetchMaxBodyBytes + 1),
			),
		),
	).rejects.toBeInstanceOf(ApiError)

	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([1]))
			controller.close()
		},
	})
	await expect(
		serializeAuthenticatedFetchResponse(
			new Response(stream, {
				headers: {
					'Content-Length': String(
						capabilityProxyAuthenticatedFetchMaxBodyBytes + 1,
					),
				},
			}),
		),
	).rejects.toBeInstanceOf(ApiError)
})
