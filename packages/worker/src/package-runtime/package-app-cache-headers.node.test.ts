import { expect, test } from 'vitest'
import {
	applyPackageAppCacheHeaders,
	privateCacheControl,
} from './package-app-cache-headers.ts'

test('privateCacheControl keeps browser caching and drops shared-cache directives', () => {
	expect(
		[
			null,
			'',
			'public, max-age=31536000, immutable',
			'max-age=60, s-maxage=600, stale-while-revalidate=30',
			'private, max-age=60',
			'no-store',
			'no-cache, public, proxy-revalidate',
		].map((value) => privateCacheControl(value)),
	).toEqual([
		'private',
		'private',
		'private, max-age=31536000, immutable',
		'private, max-age=60, stale-while-revalidate=30',
		'private, max-age=60',
		'no-store',
		'private, no-cache',
	])
})

test('signed-in responses become private and every response varies on Cookie', async () => {
	const app = () =>
		new Response('hello', {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=300',
				Vary: 'Accept-Encoding',
				ETag: '"v1"',
			},
		})

	const signedIn = applyPackageAppCacheHeaders(app(), 'signed-in')
	expect(Object.fromEntries(signedIn.headers)).toMatchObject({
		'cache-control': 'private, max-age=300',
		vary: 'Accept-Encoding, Cookie',
		etag: '"v1"',
	})
	await expect(signedIn.text()).resolves.toBe('hello')

	const anonymous = applyPackageAppCacheHeaders(app(), 'anonymous')
	expect(anonymous.headers.get('Cache-Control')).toBe('public, max-age=300')
	expect(anonymous.headers.get('Vary')).toBe('Accept-Encoding, Cookie')

	const alreadyVaries = applyPackageAppCacheHeaders(
		new Response(null, { headers: { Vary: 'cookie' } }),
		'anonymous',
	)
	expect(alreadyVaries.headers.get('Vary')).toBe('cookie')
})
