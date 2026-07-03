import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { firstPartySecurityHeaders } from '#worker/app/security-headers.ts'

function createRequest(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	return new Request(`https://test.kody.dev${path}`, options)
}

async function workerFetch(request: Request): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

test('first-party HTML shell carries security headers', async () => {
	const response = await workerFetch(createRequest('/login'))
	expect(response.status).toBe(200)
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		expect(response.headers.get(name)).toBe(value)
	}
})

test('generated-ui dev route is reachable in the non-production test env', async () => {
	// The test wrangler environment sets SENTRY_ENVIRONMENT=test, which is a
	// non-production runtime, so the developer route is served. In production
	// (SENTRY_ENVIRONMENT=production) the same request returns 404 immediately
	// without falling through to assets or the app router.
	const response = await workerFetch(createRequest('/dev/generated-ui'))
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')

	// Non-GET/HEAD methods hit the early 404 branch even in non-production.
	const postResponse = await workerFetch(
		createRequest('/dev/generated-ui', { method: 'POST' }),
	)
	expect(postResponse.status).toBe(404)
})
