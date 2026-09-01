import { expect, test, vi } from 'vitest'
import { isRouteLoaderRedirect } from '#client/route-loader.ts'

vi.mock('#client/frame-prefetch.ts', () => ({
	prefetchFrame: async () => {},
}))

const { communityDetailRouteLoader, packageMoveDestination } =
	await import('./community-detail-shared.ts')

function jsonResponse(body: unknown, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

test('settings rename hops keep the settings path', () => {
	expect(packageMoveDestination('/@owner/old/settings', '/@owner/new')).toBe(
		'/@owner/new/settings',
	)
	expect(packageMoveDestination('/@owner/old', '/@owner/new')).toBe(
		'/@owner/new',
	)
})

test('settings loader follows a rename to settings, not the README', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			jsonResponse(
				{
					ok: false,
					error: 'Public package moved.',
					redirectTo: '/@owner/new',
				},
				404,
			),
		),
	)
	const result = await communityDetailRouteLoader(
		new URL('https://example.com/@owner/old/settings'),
		new AbortController().signal,
	)
	expect(isRouteLoaderRedirect(result)).toBe(true)
	if (isRouteLoaderRedirect(result)) {
		expect(result.to).toBe('/@owner/new/settings')
	}
	vi.unstubAllGlobals()
})

test('settings loader 404s for listed packages the viewer does not own', async () => {
	const listedPublic = {
		ok: true,
		listing: { id: 'listing-1', kodyId: 'demo' },
		viewerIsOwner: false,
		ownerPackage: null,
		username: 'owner',
		kodyId: 'demo',
		loggedIn: true,
		viewerIsAdmin: false,
		forkPrompt: '',
		viewerInstall: null,
		readmeContent: '# Demo',
		isPrivate: false,
		ownerProfilePublic: true,
		invocationUrlOrigin: 'https://example.com',
	}
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse(listedPublic, 200)),
	)
	await expect(
		communityDetailRouteLoader(
			new URL('https://example.com/@owner/demo/settings'),
			new AbortController().signal,
		),
	).rejects.toThrow('Community listing not found.')

	await expect(
		communityDetailRouteLoader(
			new URL('https://example.com/@owner/demo'),
			new AbortController().signal,
		),
	).resolves.toMatchObject({
		communityDetailShell: {
			ok: true,
			viewerIsOwner: false,
			kodyId: 'demo',
		},
	})
	vi.unstubAllGlobals()
})
