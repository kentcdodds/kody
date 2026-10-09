import { exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { firstPartySecurityHeaders } from '#worker/app/security-headers.ts'

function createRequest(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	return new Request(`https://test.kody.dev${path}`, options)
}

async function workerFetch(request: Request): Promise<Response> {
	return await exports.default.fetch(request)
}

test('first-party HTML shell carries security headers', async () => {
	const response = await workerFetch(createRequest('/login'))
	expect(response.status).toBe(200)
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		expect(response.headers.get(name)).toBe(value)
	}
})
