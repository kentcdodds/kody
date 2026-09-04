import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import {
	anonymousHtmlEdgeCacheHeader,
	buildAnonymousHtmlCacheKey,
	serveAnonymousHtmlFromCache,
} from '#app/anonymous-html-edge-cache.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const env = { APP_BASE_URL: 'https://test.kody.dev' }
const encoder = new TextEncoder()
const completeDocument =
	'<!DOCTYPE html><html><body>ok</body></html><!-- rmx:flush document -->'

function storeableHtml(body: BodyInit) {
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousHtmlCacheControl,
			Vary: 'Cookie',
		},
	})
}

async function serve(request: Request, upstream: () => Response) {
	const ctx = createExecutionContext()
	const response = await serveAnonymousHtmlFromCache(request, env, ctx, () =>
		Promise.resolve(upstream()),
	)
	const text = await response.text()
	await waitOnExecutionContext(ctx)
	return {
		response,
		text,
		cached: await caches.default.match(
			buildAnonymousHtmlCacheKey(request, env),
		),
	}
}

test('a complete anonymous document is stored and replayed', async () => {
	const url = `https://test.kody.dev/pricing?complete=${crypto.randomUUID()}`
	const miss = await serve(new Request(url), () =>
		storeableHtml(completeDocument),
	)
	expect(miss.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
	expect(miss.text).toBe(completeDocument)
	await expect(miss.cached?.text()).resolves.toBe(completeDocument)

	const hit = await serve(new Request(url), () => {
		throw new Error('upstream must not run on a HIT')
	})
	expect(hit.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
	expect(hit.text).toBe(completeDocument)
})

test('a 200 whose body stopped after the doctype is served once but never stored', async () => {
	silenceExpectedConsoleWarns(['anonymous-html-cache-skip-incomplete'])
	const url = `https://test.kody.dev/onboarding?truncated=${crypto.randomUUID()}`

	// An SSR render aborted by a Vite HMR re-evaluation used to end here: a
	// committed 200 with 15 bytes. Stored, it became a blank page for every
	// later anonymous visit.
	const truncated = await serve(new Request(url), () =>
		storeableHtml('<!DOCTYPE html>'),
	)
	expect(truncated.response.status).toBe(200)
	expect(truncated.text).toBe('<!DOCTYPE html>')
	expect(truncated.cached).toBeUndefined()

	const recovered = await serve(new Request(url), () =>
		storeableHtml(completeDocument),
	)
	expect(recovered.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe(
		'MISS',
	)
	expect(recovered.text).toBe(completeDocument)
	await expect(recovered.cached?.text()).resolves.toBe(completeDocument)
})

test('a body that errors mid-stream is never stored', async () => {
	const url = `https://test.kody.dev/pricing?errored=${crypto.randomUUID()}`
	const ctx = createExecutionContext()
	const response = await serveAnonymousHtmlFromCache(
		new Request(url),
		env,
		ctx,
		() =>
			Promise.resolve(
				storeableHtml(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode('<!DOCTYPE html><html>'))
							controller.error(new Error('render failed'))
						},
					}),
				),
			),
	)
	await expect(response.text()).rejects.toThrow('render failed')
	await waitOnExecutionContext(ctx)
	expect(
		await caches.default.match(
			buildAnonymousHtmlCacheKey(new Request(url), env),
		),
	).toBeUndefined()
})
