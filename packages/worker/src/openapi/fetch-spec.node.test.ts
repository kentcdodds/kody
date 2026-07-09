import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { fetchOpenApiSpecText } from './fetch-spec.ts'

const SPEC_URL = 'https://specs.example/openapi.json'

test('fetchOpenApiSpecText rejects non-https URLs', async () => {
	await expect(
		fetchOpenApiSpecText({ specUrl: 'http://specs.example/openapi.json' }),
	).rejects.toThrow(/must use https/)
	await expect(
		fetchOpenApiSpecText({ specUrl: 'ftp://specs.example/openapi.json' }),
	).rejects.toThrow(/must use https/)
	await expect(fetchOpenApiSpecText({ specUrl: 'not-a-url' })).rejects.toThrow(
		/not a valid URL/,
	)
})

test('fetchOpenApiSpecText rejects embedded credentials', async () => {
	await expect(
		fetchOpenApiSpecText({
			specUrl: 'https://user:pass@specs.example/openapi.json',
		}),
	).rejects.toThrow(/embedded credentials/)
})

test('fetchOpenApiSpecText rejects non-OK responses', async () => {
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () =>
			HttpResponse.json({ error: 'nope' }, { status: 503 }),
		),
	])

	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).rejects.toThrow(
		/HTTP 503/,
	)
})

test('fetchOpenApiSpecText rejects oversized bodies via readBoundedBody', async () => {
	const body = 'x'.repeat(101)
	using _oversizedServer = createMswNodeServer([
		http.get(SPEC_URL, () => new HttpResponse(body)),
	])

	await expect(
		fetchOpenApiSpecText({ specUrl: SPEC_URL, maxBytes: 100 }),
	).rejects.toThrow(/response exceeds 100 bytes/)

	using _contentLengthServer = createMswNodeServer([
		http.get(
			SPEC_URL,
			() =>
				new HttpResponse('tiny', {
					headers: { 'Content-Length': '101' },
				}),
		),
	])

	await expect(
		fetchOpenApiSpecText({ specUrl: SPEC_URL, maxBytes: 100 }),
	).rejects.toThrow(/response exceeds 100 bytes/)
})

test('fetchOpenApiSpecText returns body text on success', async () => {
	const payload = JSON.stringify({ openapi: '3.0.3', info: { title: 'ok' } })
	using _server = createMswNodeServer([
		http.get(SPEC_URL, () => new HttpResponse(payload)),
	])

	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).resolves.toBe(
		payload,
	)
})
