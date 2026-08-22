import { expect, test } from 'vitest'
import { createCodeRunsApiHandler } from './code-runs.ts'

test('code-runs.json returns a public window when KV has a pair', async () => {
	const window = {
		previous: 1000,
		current: 1240,
		windowStart: '2026-08-21T00:00:00.000Z',
		windowEnd: '2026-08-22T00:00:00.000Z',
	}
	const env = {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: string) {
				return type === 'json' ? window : JSON.stringify(window)
			},
		},
	} as Env
	const response = await createCodeRunsApiHandler(env).handler()
	expect(response.status).toBe(200)
	expect(response.headers.get('cache-control')).toContain('max-age=60')
	await expect(response.json()).resolves.toEqual({ ok: true, window })
})

test('code-runs.json returns a null window when nothing is stored', async () => {
	const env = {
		BUNDLE_ARTIFACTS_KV: {
			async get() {
				return null
			},
		},
	} as Env
	const response = await createCodeRunsApiHandler(env).handler()
	await expect(response.json()).resolves.toEqual({ ok: true, window: null })
})
