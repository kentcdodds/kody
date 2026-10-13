import { expect, test, vi } from 'vitest'
import { isRouteLoaderRedirect } from '#client/route-loader.ts'

vi.mock('#client/frame-prefetch.ts', () => ({
	prefetchFrame: async () => {},
}))

const {
	communityDetailRouteLoader,
	packageMoveDestination,
	toPackageSettingsShell,
} = await import('./community-detail-shared.ts')

async function load(pathname: string, body: unknown, status: number) {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify(body), {
					status,
					headers: { 'Content-Type': 'application/json' },
				}),
		),
	)
	try {
		return await communityDetailRouteLoader(
			new URL(`https://example.com${pathname}`),
			new AbortController().signal,
		)
	} finally {
		vi.unstubAllGlobals()
	}
}

const listedPublic = {
	ok: true,
	listing: { id: 'listing-1', kodyId: 'demo', defaultBranch: 'develop' },
	viewerIsOwner: false,
	ownerPackage: null,
	username: 'owner',
	kodyId: 'demo',
	loggedIn: true,
	viewerIsAdmin: false,
	forkPrompt: '',
	viewerInstall: null,
	readmeContent: '# Demo',
	hasAgentsDocs: true,
	isPrivate: false,
	isInternetVisible: false,
	ownerProfilePublic: true,
	invocationUrlOrigin: 'https://example.com',
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
	const result = await load(
		'/@owner/old/settings',
		{ ok: false, error: 'Public package moved.', redirectTo: '/@owner/new' },
		404,
	)
	expect(isRouteLoaderRedirect(result)).toBe(true)
	if (isRouteLoaderRedirect(result)) {
		expect(result.to).toBe('/@owner/new/settings')
	}
})

test('settings loader 404s for listed packages the viewer does not own', async () => {
	await expect(
		load('/@owner/demo/settings', listedPublic, 200),
	).rejects.toThrow('Catalog entry not found.')
	await expect(load('/@owner/demo', listedPublic, 200)).resolves.toMatchObject({
		communityDetailShell: {
			ok: true,
			viewerIsOwner: false,
			kodyId: 'demo',
			hasAgentsDocs: true,
			listingId: 'listing-1',
			defaultBranch: 'develop',
		},
	})
})

test('settings loader keeps the repo actions for client navigation', async () => {
	const repoActions = {
		fork: null,
		publishHref: null,
		updateListingHref: null,
		packageAppHref: '/@owner/packages/demo',
	}
	const result = await load(
		'/@owner/demo/settings',
		{
			...listedPublic,
			viewerIsOwner: true,
			viewerCanManage: true,
			ownerPackage: { id: 'pkg-1', kodyId: 'demo', name: '@owner/demo' },
			repoActions,
		},
		200,
	)
	if (isRouteLoaderRedirect(result) || !result.communityDetailShell) {
		throw new Error('Expected a settings shell.')
	}
	expect(toPackageSettingsShell(result.communityDetailShell)).toMatchObject({
		kind: 'owner',
		repoActions,
	})
})

test('listing loader hides Agent docs unless the payload confirms AGENTS.md', async () => {
	const { hasAgentsDocs: _omitted, ...withoutAgentsDocs } = listedPublic
	await expect(
		load('/@owner/demo', { ...withoutAgentsDocs, loggedIn: false }, 200),
	).resolves.toMatchObject({
		communityDetailShell: { ok: true, hasAgentsDocs: false },
	})
})

test('listing and settings loaders treat a missing package as a not-found shell', async () => {
	for (const pathname of ['/@bad/bad-404', '/@bad/bad-404/settings']) {
		await expect(
			load(pathname, { ok: false, error: 'Catalog entry not found.' }, 404),
		).resolves.toEqual({ communityDetailShell: { ok: false, notFound: true } })
	}
})
