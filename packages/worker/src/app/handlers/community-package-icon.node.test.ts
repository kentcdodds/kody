import { expect, test, vi } from 'vitest'
import { createCommunityPackageIconHandler } from './community-package-icon.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	resolvePackagePageUrl: vi.fn(),
	getCommunityListingById: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadViewerPackageShare: vi.fn(),
	serveIdentityIcon: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolvePackagePageUrl: (...args: Array<unknown>) =>
		mocks.resolvePackagePageUrl(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))

vi.mock('#worker/package-registry/share-grants.ts', () => ({
	loadViewerPackageShare: (...args: Array<unknown>) =>
		mocks.loadViewerPackageShare(...args),
}))

vi.mock('./identity-icon-response.ts', () => ({
	identityIconNotFound: () => new Response('Not found', { status: 404 }),
	serveIdentityIcon: (...args: Array<unknown>) =>
		mocks.serveIdentityIcon(...args),
}))

const source = {
	id: 'source-1',
	user_id: 'owner-1',
	entity_kind: 'package' as const,
	entity_id: 'package-1',
	repo_id: 'repo-1',
	published_commit: 'pub-1',
	indexed_commit: null,
}

const publicPackage = {
	id: 'package-1',
	kodyId: 'notes',
	sourceId: 'source-1',
	hidden: false,
	isPrivate: false,
}

function callHandler(iconCommit = 'pub-1') {
	const handler = createCommunityPackageIconHandler({ APP_DB: {} } as Env)
	return handler.handler({
		request: new Request(`https://example.com/@kent/notes/icon/${iconCommit}`),
		params: { username: 'kent', kodyId: 'notes', iconCommit },
		url: new URL(`https://example.com/@kent/notes/icon/${iconCommit}`),
	} as never)
}

test('package identity icon serves the published commit for guest-visible packages', async () => {
	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicPackage,
		listingId: null,
	})
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	mocks.getEntitySourceById.mockResolvedValue(source)
	mocks.serveIdentityIcon.mockResolvedValue(
		new Response('icon', { status: 200 }),
	)

	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(mocks.serveIdentityIcon).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'repo-1',
			iconCommit: 'pub-1',
			includePackageAppIcon: true,
			leafName: 'notes',
		}),
	)
})

test('package identity icon rejects stale commits and hidden private packages', async () => {
	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: { ...publicPackage, hidden: true, isPrivate: true },
		listingId: null,
	})
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	expect((await callHandler()).status).toBe(404)

	mocks.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'kent',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicPackage,
		listingId: null,
	})
	mocks.getEntitySourceById.mockResolvedValue(source)
	expect((await callHandler('old-commit')).status).toBe(404)
})
