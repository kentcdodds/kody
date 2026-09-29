import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { tinyPngBytes } from '#worker/test-support/images-binding.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'
import { bytesToLatin1String } from '#universal/package-file-media.ts'

const mocks = vi.hoisted(() => ({
	resolveCommunityPackageUrl: vi.fn<() => Promise<unknown>>(),
	getCommunityListingById: vi.fn<() => Promise<unknown>>(),
	getEntitySourceById: vi.fn<() => Promise<unknown>>(),
	readArtifactFileAtCommit: vi.fn<() => Promise<unknown>>(),
	readPublishedSourceSnapshot: vi.fn<() => Promise<unknown>>(),
	readCommunitySnapshot: vi.fn<() => Promise<unknown>>(),
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

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readPublishedSourceSnapshot(...args),
}))

vi.mock('#worker/community/snapshot.ts', () => ({
	readCommunitySnapshot: (...args: Array<unknown>) =>
		mocks.readCommunitySnapshot(...args),
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

const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env

function callPackageHandler(
	input: { username?: string; kodyId?: string; relativePath?: string } = {},
) {
	const {
		username = 'kody',
		kodyId = 'doom',
		relativePath = 'docs/poster.png',
	} = input
	const url = `https://kody.codes/@${username}/${kodyId}/assets/${relativePath}`
	return createCommunityPackageAssetHandler(env).handler({
		request: new Request(url),
		params: { username, kodyId, relativePath },
		url: new URL(url),
	} as never)
}

function callListingHandler(relativePath = 'docs/poster.png') {
	const url = `https://kody.codes/community/${listing.id}/assets/${relativePath}`
	return createCommunityDetailAssetHandler(env).handler({
		request: new Request(url),
		params: { listingId: listing.id, relativePath },
		url: new URL(url),
	} as never)
}

async function bytesOf(response: Response) {
	return {
		status: response.status,
		bytes: new Uint8Array(await response.arrayBuffer()),
	}
}

const posterSnapshot = {
	files: { 'docs/poster.png': bytesToLatin1String(tinyPngBytes) },
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
	mocks.readPublishedSourceSnapshot.mockResolvedValue(null)
	mocks.readCommunitySnapshot.mockResolvedValue(null)

	const response = await callPackageHandler()
	expect(Object.fromEntries(response.headers)).toMatchObject({
		'content-type': 'image/png',
		'cache-control': 'public, max-age=3600',
		'x-content-type-options': 'nosniff',
		'cross-origin-resource-policy': 'same-origin',
	})
	expect(await bytesOf(response)).toEqual({ status: 200, bytes: tinyPngBytes })
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

	for (const unsafe of [
		{ relativePath: '../secret.png' },
		{ relativePath: 'src/index.ts' },
		{ kodyId: 'packages' },
	]) {
		const { status } = await callPackageHandler(unsafe)
		expect({ unsafe, status }).toEqual({ unsafe, status: 404 })
	}

	mocks.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode('not-an-image'),
	)
	expect((await callPackageHandler()).status).toBe(404)

	consoleError.mockImplementation(() => {})
	mocks.readArtifactFileAtCommit.mockRejectedValue(new Error('git down'))
	expect((await callPackageHandler()).status).toBe(404)
	expect(consoleError).toHaveBeenCalledWith(
		'package-readme-asset-load-failed',
		listing.sourceId,
		'docs/poster.png',
		expect.any(Error),
	)

	// With git unavailable, published and listing snapshots still serve bytes.
	mocks.readPublishedSourceSnapshot.mockResolvedValue(posterSnapshot)
	expect(await bytesOf(await callPackageHandler())).toEqual({
		status: 200,
		bytes: tinyPngBytes,
	})
	mocks.readPublishedSourceSnapshot.mockResolvedValue(null)
	mocks.readCommunitySnapshot.mockResolvedValue(posterSnapshot)
	expect(await bytesOf(await callListingHandler())).toEqual({
		status: 200,
		bytes: tinyPngBytes,
	})
	mocks.readCommunitySnapshot.mockResolvedValue(null)

	// Unlisted packages serve the owner's published commit privately, owner only.
	mocks.resolveCommunityPackageUrl.mockResolvedValue(null)
	const ownerPage = (viewerIsOwner: boolean) => ({
		kind: 'page',
		ownerPackage: { sourceId: 'owner-source', publishedCommit: 'def456' },
		viewerIsOwner,
	})
	mocks.loadPackagePage.mockResolvedValue(ownerPage(true))
	mocks.getEntitySourceById.mockResolvedValue({ repo_id: 'owner-repo' })
	mocks.readArtifactFileAtCommit.mockResolvedValue(tinyPngBytes)
	const privateResponse = await callPackageHandler()
	expect(privateResponse.status).toBe(200)
	expect(privateResponse.headers.get('Cache-Control')).toBe('private, no-store')
	expect(mocks.readArtifactFileAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({ repoId: 'owner-repo', commit: 'def456' }),
	)

	mocks.loadPackagePage.mockResolvedValue(ownerPage(false))
	expect((await callPackageHandler()).status).toBe(404)
})
