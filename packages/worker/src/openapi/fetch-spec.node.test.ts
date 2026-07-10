import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { fetchOpenApiSpecText } from './fetch-spec.ts'

const SPEC_URL = 'https://specs.example/openapi.json'

test('fetchOpenApiSpecText rejects unsafe URLs, credentials, and bad responses', async () => {
	await expect(
		fetchOpenApiSpecText({ specUrl: 'http://specs.example/openapi.json' }),
	).rejects.toThrow(/must use https/)
	await expect(
		fetchOpenApiSpecText({ specUrl: 'ftp://specs.example/openapi.json' }),
	).rejects.toThrow(/must use https/)
	await expect(fetchOpenApiSpecText({ specUrl: 'not-a-url' })).rejects.toThrow(
		/not a valid URL/,
	)
	await expect(
		fetchOpenApiSpecText({
			specUrl: 'https://user:pass@specs.example/openapi.json',
		}),
	).rejects.toThrow(/embedded credentials/)
	await expect(
		fetchOpenApiSpecText({
			specUrl: 'https://user:pass@specs.example/openapi.json',
		}),
	).rejects.toThrow(/embedded credentials/)

	using _badResponseServer = createMswNodeServer([
		http.get(SPEC_URL, () =>
			HttpResponse.json({ error: 'nope' }, { status: 503 }),
		),
	])
	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).rejects.toThrow(
		/HTTP 503/,
	)

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

test('fetchOpenApiSpecText follows safe redirects and rejects unsafe redirect chains', async () => {
	const payload = JSON.stringify({ openapi: '3.0.3', info: { title: 'ok' } })
	using _successServer = createMswNodeServer([
		http.get(SPEC_URL, () => new HttpResponse(payload)),
	])
	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).resolves.toBe(
		payload,
	)

	using _httpRedirectServer = createMswNodeServer([
		http.get(
			SPEC_URL,
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'http://specs.example/openapi.json' },
				}),
		),
	])
	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).rejects.toThrow(
		/must use https/,
	)

	const finalUrl = 'https://specs.example/v2/openapi.json'
	using _httpsRedirectServer = createMswNodeServer([
		http.get(
			SPEC_URL,
			() =>
				new HttpResponse(null, {
					status: 301,
					headers: { Location: finalUrl },
				}),
		),
		http.get(finalUrl, () => new HttpResponse(payload)),
	])
	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).resolves.toBe(
		payload,
	)

	using _credentialRedirectServer = createMswNodeServer([
		http.get(
			SPEC_URL,
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: {
						Location: 'https://user:pass@specs.example/openapi.json',
					},
				}),
		),
	])
	await expect(fetchOpenApiSpecText({ specUrl: SPEC_URL })).rejects.toThrow(
		/embedded credentials/,
	)

	using _hopServer = createMswNodeServer([
		http.get(
			'https://specs.example/hop-0',
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'https://specs.example/hop-1' },
				}),
		),
		http.get(
			'https://specs.example/hop-1',
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'https://specs.example/hop-2' },
				}),
		),
		http.get(
			'https://specs.example/hop-2',
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'https://specs.example/hop-3' },
				}),
		),
		http.get(
			'https://specs.example/hop-3',
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'https://specs.example/hop-4' },
				}),
		),
		http.get(
			'https://specs.example/hop-4',
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'https://specs.example/hop-5' },
				}),
		),
		http.get(
			'https://specs.example/hop-5',
			() =>
				new HttpResponse(null, {
					status: 302,
					headers: { Location: 'https://specs.example/hop-6' },
				}),
		),
	])
	await expect(
		fetchOpenApiSpecText({ specUrl: 'https://specs.example/hop-0' }),
	).rejects.toThrow(/too many redirects/)
})
