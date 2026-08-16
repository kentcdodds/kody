import { expect, test } from 'vitest'

import { runNxRemoteCacheSmoke } from './nx-remote-cache-smoke.ts'

test('Nx client writes and restores artifacts through the self-hosted HTTP cache', async () => {
	const result = await runNxRemoteCacheSmoke()
	expect(
		result.requests.some(
			(entry) => entry.method === 'PUT' && entry.status === 200,
		),
	).toBe(true)
	expect(
		result.requests.some(
			(entry) =>
				entry.method === 'GET' &&
				entry.pathname.startsWith('/v1/cache/') &&
				entry.status === 200,
		),
	).toBe(true)
	expect(result.secondOutput).toMatch(/cache:\s+1\/1 hit/i)
}, 60_000)
