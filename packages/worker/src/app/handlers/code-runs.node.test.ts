import { expect, test } from 'vitest'
import { createCodeRunsApiHandler } from './code-runs.ts'

test('code-runs.json returns the stored public window or null', async () => {
	const window = {
		previous: 1000,
		current: 1240,
		windowStart: '2026-08-21T00:00:00.000Z',
		windowEnd: '2026-08-22T00:00:00.000Z',
	}
	const present = await createCodeRunsApiHandler({
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: string) {
				return type === 'json' ? window : JSON.stringify(window)
			},
		},
	} as Env).handler()
	expect(present.status).toBe(200)
	expect(present.headers.get('cache-control')).toContain('max-age=60')
	await expect(present.json()).resolves.toEqual({ ok: true, window })

	const missing = await createCodeRunsApiHandler({
		BUNDLE_ARTIFACTS_KV: {
			async get() {
				return null
			},
		},
	} as Env).handler()
	await expect(missing.json()).resolves.toEqual({ ok: true, window: null })
})
