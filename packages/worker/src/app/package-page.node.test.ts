import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolvePackagePageUrl: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	loadCommunityDetailData: vi.fn(),
	loadAccountPackageDetail: vi.fn(),
	loadViewerPackageShare: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolvePackagePageUrl: (...args: Array<unknown>) =>
		mockModule.resolvePackagePageUrl(...args),
	getCommunityPackageHref: (input: { username: string; kodyId: string }) =>
		`/@${input.username}/${input.kodyId}`,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/community-data.ts', () => ({
	loadCommunityDetailData: (...args: Array<unknown>) =>
		mockModule.loadCommunityDetailData(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackageDetail: (...args: Array<unknown>) =>
		mockModule.loadAccountPackageDetail(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/package-registry/share-grants.ts', () => ({
	loadViewerPackageShare: (...args: Array<unknown>) =>
		mockModule.loadViewerPackageShare(...args),
	toPackageShareGrantLoaderView: (view: unknown) => view,
}))

const { loadPackagePage, packagePageIsPrivate } =
	await import('./package-page.ts')

const request = new Request('https://example.com/@owner/notes')
const env = {} as Env
const ownerUser = { username: 'owner', mcpUser: { userId: 'owner-1' } }

function resolvesTo(
	kind: 'package' | 'redirect',
	overrides: {
		kodyId?: string
		listingId?: string | null
		listingKodyId?: string
		savedPackage?: Record<string, unknown>
	} = {},
) {
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind,
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		listingId: null,
		...(kind === 'package'
			? { savedPackage: { id: 'pkg-1', hidden: false, isPrivate: false } }
			: {}),
		...overrides,
	})
}

function load(kodyId = 'notes', username = 'owner') {
	return loadPackagePage({ env, request, username, kodyId })
}

function setProfileVisibility(profile_visibility: 'public' | 'private') {
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility,
	})
}

const listingDetail = {
	ok: true,
	listing: { id: 'listing-1', name: '@owner/notes' },
}
const ownerPackageDetail = {
	id: 'pkg-1',
	name: '@owner/notes',
	kodyId: 'notes',
}
const pkg = (overrides: Record<string, unknown>) => ({
	savedPackage: { id: 'pkg-1', hidden: false, isPrivate: false, ...overrides },
})

test('loadPackagePage applies the owner / community / public visibility matrix', async () => {
	setProfileVisibility('public')
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.resolvePackagePageUrl.mockResolvedValue(null)
	await expect(load('missing')).resolves.toEqual({ kind: 'not_found' })

	const anonymousCases = [
		{ name: 'hidden', ...pkg({ hidden: true }), expected: 'not_found' },
		{ name: 'private', ...pkg({ isPrivate: true }), expected: 'not_found' },
		{ name: 'public, unlisted', ...pkg({}), expected: 'unauthorized' },
	]
	for (const { name, savedPackage, expected } of anonymousCases) {
		resolvesTo('package', { savedPackage })
		expect({ name, result: await load() }).toEqual({
			name,
			result: { kind: expected },
		})
	}

	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail)
	resolvesTo('package', { listingId: 'listing-1' })
	expect(await load()).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		listing: { listing: { id: 'listing-1' } },
		ownerPackage: null,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser)
	mockModule.loadAccountPackageDetail.mockResolvedValue(ownerPackageDetail)
	resolvesTo('package', pkg({ hidden: true }))
	expect(await load()).toMatchObject({
		kind: 'page',
		viewerIsOwner: true,
		ownerPackage: { id: 'pkg-1' },
		listing: null,
		ownerProfilePublic: true,
	})

	// Unlisted renames only redirect the owner; listed renames redirect anyone.
	resolvesTo('redirect', { kodyId: 'renamed' })
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	await expect(load('old')).resolves.toEqual({ kind: 'not_found' })
	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser)
	await expect(load('old')).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/renamed',
		shared: false,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	resolvesTo('redirect', { listingId: 'listing-1' })
	await expect(load('notes', 'old')).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes',
		shared: true,
	})
})

test('loadPackagePage does not send anonymous visitors to an unpublished listing rename', async () => {
	const listingLag = {
		listingId: 'listing-1',
		listingKodyId: 'notes',
		savedPackage: {
			id: 'pkg-1',
			kodyId: 'notes-two',
			hidden: false,
			isPrivate: false,
		},
	}
	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)

	resolvesTo('package', listingLag)
	expect(await load()).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		listing: { listing: { id: 'listing-1' } },
	})

	resolvesTo('package', { ...listingLag, kodyId: 'notes-two' })
	await expect(load('notes-two')).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes',
		shared: true,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser)
	resolvesTo('package', listingLag)
	await expect(load()).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes-two',
		shared: false,
	})
})

test('loadPackagePage lets pending and accepted share guests see a private package', async () => {
	setProfileVisibility('private')
	mockModule.loadCommunityDetailData.mockResolvedValue(null)
	mockModule.loadAccountPackageDetail.mockResolvedValue({
		...ownerPackageDetail,
		isPrivate: true,
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'guest@example.com',
		mcpUser: { userId: 'guest-1' },
	})
	resolvesTo('package', pkg({ isPrivate: true }))
	const shareGrant = (status: string) => ({
		id: 'grant-1',
		status,
		packageName: '@owner/notes',
	})

	mockModule.loadViewerPackageShare.mockResolvedValue(shareGrant('pending'))
	const pending = await load()
	expect(pending).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		loggedIn: true,
		ownerPackage: null,
		canReadOwnerSource: false,
		shareGrant: { id: 'grant-1', status: 'pending' },
		ownerProfilePublic: false,
	})
	expect(pending.kind === 'page' && packagePageIsPrivate(pending)).toBe(true)

	mockModule.loadViewerPackageShare.mockResolvedValue(shareGrant('accepted'))
	expect(await load()).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		ownerPackage: { id: 'pkg-1' },
		canReadOwnerSource: true,
		shareGrant: { id: 'grant-1', status: 'accepted' },
		ownerProfilePublic: false,
	})
})
