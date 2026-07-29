import { expect, test } from 'vitest'
import {
	getClientModulePreloadHrefs,
	resetClientPreloadManifestCache,
} from '#app/client-preload-manifest.ts'

const manifest = {
	entry: ['/assets/chunk-A.js', '/assets/chunk-B.js'],
	areas: {
		'account-area': ['/assets/account-area-H1.js', '/assets/chunk-C.js'],
	},
}

function fakeAssets(handler: () => Promise<Response>) {
	let fetchCount = 0
	return {
		fetcher: {
			fetch: async () => {
				fetchCount += 1
				return handler()
			},
		},
		getFetchCount: () => fetchCount,
	}
}

function jsonResponse(body: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify(body), {
			headers: { 'Content-Type': 'application/json' },
		}),
	)
}

test('returns entry hrefs plus area hrefs for lazy routes, entry only for eager routes', async () => {
	resetClientPreloadManifestCache()
	const { fetcher } = fakeAssets(() => jsonResponse(manifest))

	expect(
		await getClientModulePreloadHrefs({
			assets: fetcher,
			buildId: 'abc1234',
			pathname: '/account',
		}),
	).toEqual([
		'/assets/chunk-A.js',
		'/assets/chunk-B.js',
		'/assets/account-area-H1.js',
		'/assets/chunk-C.js',
	])

	expect(
		await getClientModulePreloadHrefs({
			assets: fetcher,
			buildId: 'abc1234',
			pathname: '/',
		}),
	).toEqual(['/assets/chunk-A.js', '/assets/chunk-B.js'])
})

test('skips preload hints in dev and without an assets fetcher', async () => {
	resetClientPreloadManifestCache()
	const { fetcher, getFetchCount } = fakeAssets(() => jsonResponse(manifest))

	expect(
		await getClientModulePreloadHrefs({
			assets: fetcher,
			buildId: 'dev',
			pathname: '/',
		}),
	).toEqual([])
	expect(getFetchCount()).toBe(0)

	expect(
		await getClientModulePreloadHrefs({
			assets: undefined,
			buildId: 'abc1234',
			pathname: '/',
		}),
	).toEqual([])
})

test('rejects malformed manifests (non-/assets/ hrefs)', async () => {
	resetClientPreloadManifestCache()
	const { fetcher } = fakeAssets(() =>
		jsonResponse({
			entry: ['https://evil.example/x.js'],
			areas: {},
		}),
	)

	expect(
		await getClientModulePreloadHrefs({
			assets: fetcher,
			buildId: 'abc1234',
			pathname: '/',
		}),
	).toEqual([])
})

test('caches a loaded manifest per build id but retries after failures', async () => {
	resetClientPreloadManifestCache()
	let failing = true
	const { fetcher, getFetchCount } = fakeAssets(() => {
		if (failing) return Promise.reject(new Error('assets unavailable'))
		return jsonResponse(manifest)
	})
	const input = { assets: fetcher, buildId: 'abc1234', pathname: '/' }

	// Transient failure: no hints, and the null result is NOT cached.
	expect(await getClientModulePreloadHrefs(input)).toEqual([])
	expect(getFetchCount()).toBe(1)

	failing = false
	expect(await getClientModulePreloadHrefs(input)).toEqual(manifest.entry)
	expect(getFetchCount()).toBe(2)

	// Success is cached: no further assets fetches for the same build id.
	expect(await getClientModulePreloadHrefs(input)).toEqual(manifest.entry)
	expect(getFetchCount()).toBe(2)
})
