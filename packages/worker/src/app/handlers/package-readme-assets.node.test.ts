import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { tinyPngBytes } from '#worker/test-support/images-binding.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'

const mocks = vi.hoisted(() => ({
	resolveCommunityPackageUrl: vi.fn<() => Promise<unknown>>(),
	getCommunityListingById: vi.fn<() => Promise<unknown>>(),
	getEntitySourceById: vi.fn<() => Promise<unknown>>(),
	readArtifactFileAtCommit: vi.fn<() => Promise<unknown>>(),
	loadPackagePage: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolveCommunityPackageUrl: (...args: Array<unknown>) =>
		mocks.resolveCommunityPackageUrl(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: (...args: Array<unknown>) =>
		mocks.readArtifactFileAtCommit(...args),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Array<unknown>) => mocks.loadPackagePage(...args),
}))

const {
	createCommunityDetailAssetHandler,
	createCommunityPackageAssetHandler,
} = await import('./package-readme-assets.ts')

const listing = {
	id: 'listing-1',
	ownerUserId: 'owner-1',
	packageId: 'package-1',
	sourceId: 'source-1',
	kodyId: 'doom',
	name: '@kody/doom',
	description: 'DOOM',
	tags: [],
	category: 'integrations',
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	iconCommit: 'abc123',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-07-10T00:00:00.000Z',
	updatedAt: '2026-07-10T00:00:00.000Z',
	publishedAt: '2026-07-10T00:00:00.000Z',
} satisfies CommunityListingRecord

function callPackageHandler(input: {
	username?: string
	kodyId?: string
	relativePath?: string
}) {
	const username = input.username ?? 'kody'
	const kodyId = input.kodyId ?? 'doom'
	const relativePath = input.relativePath ?? 'docs/poster.png'
	const handler = createCommunityPackageAssetHandler({ APP_DB: {} } as Env)
	const url = `https://kody.codes/@${username}/${kodyId}/assets/${relativePath}`
	return handler.handler({
		request: new Request(url),
		params: { username, kodyId, relativePath },
		url: new URL(url),
	} as never)
}

function callListingHandler(relativePath = 'docs/poster.png') {
	const handler = createCommunityDetailAssetHandler({ APP_DB: {} } as Env)
	const url = `https://kody.codes/community/${listing.id}/assets/${relativePath}`
	return handler.handler({
		request: new Request(url),
		params: { listingId: listing.id, relativePath },
		url: new URL(url),
	} as never)
}

test('package README asset handlers serve published image bytes and refuse unsafe paths', async () => {
	mocks.resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: listing.id,
		username: 'kody',
		kodyId: 'doom',
	})
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.getEntitySourceById.mockResolvedValue({ repo_id: 'repo-1' })
	mocks.readArtifactFileAtCommit.mockResolvedValue(tinyPngBytes)

	const response = await callPackageHandler({})
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/png')
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe(
		'same-origin',
	)
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(tinyPngBytes)
	expect(mocks.readArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'repo-1',
			commit: listing.pinnedCommit,
			filePath: 'docs/poster.png',
		}),
	)

	const listingResponse = await callListingHandler()
	expect(listingResponse.status).toBe(200)
	expect(listingResponse.headers.get('Content-Type')).toBe('image/png')

	expect(
		(await callPackageHandler({ relativePath: '../secret.png' })).status,
	).toBe(404)
	expect(
		(await callPackageHandler({ relativePath: 'src/index.ts' })).status,
	).toBe(404)
	expect((await callPackageHandler({ kodyId: 'packages' })).status).toBe(404)

	mocks.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode('not-an-image'),
	)
	expect((await callPackageHandler({})).status).toBe(404)

	consoleError.mockImplementation(() => {})
	mocks.readArtifactFileAtCommit.mockRejectedValue(new Error('git down'))
	expect((await callPackageHandler({})).status).toBe(404)
	expect(consoleError).toHaveBeenCalledWith(
		'package-readme-asset-load-failed',
		listing.sourceId,
		'docs/poster.png',
		expect.any(Error),
	)

	mocks.resolveCommunityPackageUrl.mockResolvedValue(null)
	mocks.loadPackagePage.mockResolvedValue({
		kind: 'page',
		ownerPackage: { sourceId: 'owner-source', publishedCommit: 'def456' },
		viewerIsOwner: true,
	})
	mocks.getEntitySourceById.mockResolvedValue({ repo_id: 'owner-repo' })
	mocks.readArtifactFileAtCommit.mockResolvedValue(tinyPngBytes)
	const privateResponse = await callPackageHandler({})
	expect(privateResponse.status).toBe(200)
	expect(privateResponse.headers.get('Cache-Control')).toBe('private, no-store')
	expect(mocks.readArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'owner-repo',
			commit: 'def456',
		}),
	)

	mocks.loadPackagePage.mockResolvedValue({
		kind: 'page',
		ownerPackage: { sourceId: 'owner-source', publishedCommit: 'def456' },
		viewerIsOwner: false,
	})
	expect((await callPackageHandler({})).status).toBe(404)
})
