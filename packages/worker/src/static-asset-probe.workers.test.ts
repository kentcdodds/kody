import { expect, test } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { originWorkerHandler } from './origin-handler.ts'

function trackAssetFetches(base: Env) {
	const pathnames: Array<string> = []
	const tracked = new Proxy(base, {
		get(target, property, receiver) {
			if (property === 'ASSETS') {
				return {
					fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
						const url =
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.href
									: input.url
						pathnames.push(new URL(url).pathname)
						return target.ASSETS.fetch(input, init)
					},
					connect: target.ASSETS.connect.bind(target.ASSETS),
				}
			}
			const value = Reflect.get(target, property, receiver)
			if (typeof value === 'function') {
				return value.bind(target)
			}
			return value
		},
	}) as Env
	return { env: tracked, pathnames }
}

async function workerFetch(request: Request, workerEnv: Env) {
	const handleFetch = originWorkerHandler.fetch
	if (!handleFetch) throw new Error('Expected the origin fetch handler.')
	const ctx = createExecutionContext()
	const response = await handleFetch(request, workerEnv, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

test('a public file is served from ASSETS and a dynamic prefix never fetches that path', async () => {
	const tracked = trackAssetFetches(env)
	const assetResponse = await workerFetch(
		new Request('https://test.kody.dev/favicon.ico'),
		tracked.env,
	)
	expect(assetResponse.status).toBe(200)
	expect(assetResponse.headers.get('Content-Type') ?? '').toMatch(/image|icon/i)
	const assetBytes = await assetResponse.arrayBuffer()
	expect(assetBytes.byteLength).toBeGreaterThan(0)
	expect(tracked.pathnames).toContain('/favicon.ico')

	const beforeAccount = tracked.pathnames.length
	const accountResponse = await workerFetch(
		new Request('https://test.kody.dev/account'),
		tracked.env,
	)
	await accountResponse.body?.cancel()
	const accountFetches = tracked.pathnames.slice(beforeAccount)
	expect(
		accountFetches.some(
			(pathname) => pathname === '/account' || pathname.startsWith('/account/'),
		),
	).toBe(false)

	const beforeOrg = tracked.pathnames.length
	const orgResponse = await workerFetch(
		new Request('https://test.kody.dev/@acme/-/jobs'),
		tracked.env,
	)
	await orgResponse.body?.cancel()
	const orgFetches = tracked.pathnames.slice(beforeOrg)
	expect(
		orgFetches.some(
			(pathname) => pathname === '/@acme/-/jobs' || pathname.startsWith('/@'),
		),
	).toBe(false)
})
