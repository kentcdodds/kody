import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolveCommunityPackageUrl: vi.fn<() => Promise<unknown>>(),
	getCommunityListingById: vi.fn<() => Promise<unknown>>(),
	getEntitySourceById: vi.fn<() => Promise<unknown>>(),
	resolveArtifactSourceHead: vi.fn<() => Promise<unknown>>(),
	loadPackagePage: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	getCommunityPackageHref: (input: { username: string; kodyId: string }) =>
		`/@${input.username}/${input.kodyId}`,
	resolveCommunityPackageUrl: mockModule.resolveCommunityPackageUrl,
}))
vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: mockModule.getCommunityListingById,
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))
vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: mockModule.resolveArtifactSourceHead,
}))
vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: mockModule.loadPackagePage,
}))

const { resolveCommunityFilesRoute } =
	await import('./community-package-route.ts')

const env = { APP_DB: {} as D1Database } as Env

function resolveRoute(pathname: string, withRequest = false) {
	const url = `https://example.com${pathname}`
	return resolveCommunityFilesRoute({
		env,
		url: new URL(url),
		...(withRequest ? { request: new Request(url) } : {}),
	})
}

const redirect = (to: string, shared: boolean) => ({
	kind: 'redirect',
	to,
	shared,
})

function ownerPackagePage(overrides: Record<string, unknown> = {}) {
	return {
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { sourceId: 'src-1', isPrivate: true },
		viewerIsOwner: true,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
		...overrides,
	}
}

test('leftover /files and /tree/HEAD 301 to the looked-up default branch', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		username: 'kentcdodds',
		kodyId: 'devin',
	})
	mockModule.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		sourceId: 'src-1',
	})
	mockModule.getEntitySourceById.mockResolvedValue({ repo_id: 'repo-1' })
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'release',
		commit: 'abc',
	})

	for (const [pathname, to] of [
		[
			'/@kentcdodds/devin/files/src/index.ts',
			'/@kentcdodds/devin/tree/release/src/index.ts',
		],
		['/@kentcdodds/devin/tree/HEAD', '/@kentcdodds/devin/tree/release'],
		[
			'/@kentcdodds/devin/tree/head/src/index.ts',
			'/@kentcdodds/devin/tree/release/src/index.ts',
		],
	] as const) {
		expect(await resolveRoute(pathname)).toEqual(redirect(to, true))
	}

	mockModule.resolveArtifactSourceHead.mockClear()
	for (const ref of ['release', 'main']) {
		expect(await resolveRoute(`/@kentcdodds/devin/tree/${ref}`)).toEqual({
			kind: 'listing',
			listingId: 'listing-1',
			selectedPath: '',
			ref,
		})
	}
	expect(mockModule.resolveArtifactSourceHead).not.toHaveBeenCalled()

	mockModule.resolveArtifactSourceHead.mockRejectedValue(new Error('no git'))
	expect(await resolveRoute('/@kentcdodds/devin/files')).toEqual(
		redirect('/@kentcdodds/devin/tree/main', true),
	)
})

test('unlisted owner tree uses the package page; strangers are unauthorized', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	mockModule.loadPackagePage.mockResolvedValue(ownerPackagePage())
	expect(
		await resolveRoute('/@kentcdodds/friction-log/tree/main', true),
	).toEqual({
		kind: 'package',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		selectedPath: '',
		ref: 'main',
	})

	mockModule.loadPackagePage.mockResolvedValue({ kind: 'unauthorized' })
	expect(
		await resolveRoute('/@kentcdodds/friction-log/tree/main', true),
	).toEqual({ kind: 'unauthorized' })
})

test('unlisted leftover /files and rename hops stay owner-private', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.loadPackagePage.mockResolvedValue(ownerPackagePage())
	expect(await resolveRoute('/@kentcdodds/friction-log/files', true)).toEqual(
		redirect('/@kentcdodds/friction-log/tree/main', false),
	)

	mockModule.loadPackagePage.mockResolvedValue(
		redirect('/@kentcdodds/friction-log', false),
	)
	expect(await resolveRoute('/@kentcdodds/old-log/tree/main', true)).toEqual(
		redirect('/@kentcdodds/friction-log/tree/main', false),
	)

	mockModule.loadPackagePage.mockResolvedValue(
		ownerPackagePage({
			kodyId: 'friction-log-two',
			listing: { listing: { id: 'listing-1', kodyId: 'friction-log' } },
			ownerPackage: { sourceId: 'src-1', isPrivate: false },
		}),
	)
	expect(
		await resolveRoute('/@kentcdodds/friction-log-two/files', true),
	).toEqual(redirect('/@kentcdodds/friction-log-two/tree/main', false))
})
