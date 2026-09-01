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
	resolveCommunityPackageUrl: (...args: Array<unknown>) =>
		mockModule.resolveCommunityPackageUrl(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Array<unknown>) =>
		mockModule.loadPackagePage(...args),
}))

const { resolveCommunityFilesRoute } =
	await import('./community-package-route.ts')

const env = { APP_DB: {} } as Env

function filesUrl(pathname: string) {
	return new URL(`https://example.com${pathname}`)
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

	const leftover = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/devin/files/src/index.ts'),
	})
	expect(leftover).toEqual({
		kind: 'redirect',
		to: '/@kentcdodds/devin/tree/release/src/index.ts',
		shared: true,
	})

	const head = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/devin/tree/HEAD'),
	})
	expect(head).toEqual({
		kind: 'redirect',
		to: '/@kentcdodds/devin/tree/release',
		shared: true,
	})

	const headFile = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/devin/tree/head/src/index.ts'),
	})
	expect(headFile).toEqual({
		kind: 'redirect',
		to: '/@kentcdodds/devin/tree/release/src/index.ts',
		shared: true,
	})

	mockModule.resolveArtifactSourceHead.mockClear()
	const defaultBranch = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/devin/tree/release'),
	})
	expect(defaultBranch).toEqual({
		kind: 'listing',
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'release',
	})
	expect(mockModule.resolveArtifactSourceHead).not.toHaveBeenCalled()

	const otherBranch = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/devin/tree/main'),
	})
	expect(otherBranch).toEqual({
		kind: 'listing',
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'main',
	})
	expect(mockModule.resolveArtifactSourceHead).not.toHaveBeenCalled()

	mockModule.resolveArtifactSourceHead.mockRejectedValue(new Error('no git'))
	const fallback = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/devin/files'),
	})
	expect(fallback).toEqual({
		kind: 'redirect',
		to: '/@kentcdodds/devin/tree/main',
		shared: true,
	})
})

test('unlisted owner tree uses the package page; strangers are unauthorized', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { sourceId: 'src-1', isPrivate: true },
		viewerIsOwner: true,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	})

	const owner = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/friction-log/tree/main'),
		request: new Request(
			'https://example.com/@kentcdodds/friction-log/tree/main',
		),
	})
	expect(owner).toEqual({
		kind: 'package',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		selectedPath: '',
		ref: 'main',
	})

	mockModule.loadPackagePage.mockResolvedValue({ kind: 'unauthorized' })
	const stranger = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/friction-log/tree/main'),
		request: new Request(
			'https://example.com/@kentcdodds/friction-log/tree/main',
		),
	})
	expect(stranger).toEqual({ kind: 'unauthorized' })
})

test('unlisted leftover /files and rename hops stay owner-private', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { sourceId: 'src-1', isPrivate: true },
		viewerIsOwner: true,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	})

	const leftover = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/friction-log/files'),
		request: new Request('https://example.com/@kentcdodds/friction-log/files'),
	})
	expect(leftover).toEqual({
		kind: 'redirect',
		to: '/@kentcdodds/friction-log/tree/main',
		shared: false,
	})

	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'redirect',
		to: '/@kentcdodds/friction-log',
		shared: false,
	})
	const renamed = await resolveCommunityFilesRoute({
		env,
		url: filesUrl('/@kentcdodds/old-log/tree/main'),
		request: new Request('https://example.com/@kentcdodds/old-log/tree/main'),
	})
	expect(renamed).toEqual({
		kind: 'redirect',
		to: '/@kentcdodds/friction-log/tree/main',
		shared: false,
	})
})
