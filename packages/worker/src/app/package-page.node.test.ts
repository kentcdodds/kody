import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolvePackagePageUrl: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	loadCommunityDetailData: vi.fn(),
	loadAccountPackageDetail: vi.fn(),
	loadViewerPackageShare: vi.fn(),
	getAppBaseUrl: () => 'https://example.com',
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

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => mockModule.getAppBaseUrl(),
}))

vi.mock('#worker/package-registry/share-grants.ts', () => ({
	loadViewerPackageShare: (...args: Array<unknown>) =>
		mockModule.loadViewerPackageShare(...args),
	toPackageShareGrantLoaderView: (view: unknown) => view,
}))

const { loadPackagePage } = await import('./package-page.ts')

const request = new Request('https://example.com/@owner/notes')
const env = {} as Env

function ownerUser() {
	return {
		username: 'owner',
		mcpUser: { userId: 'owner-1' },
	}
}

function publicSavedPackage(overrides?: {
	hidden?: boolean
	isPrivate?: boolean
}) {
	return {
		id: 'pkg-1',
		hidden: overrides?.hidden ?? false,
		isPrivate: overrides?.isPrivate ?? false,
	}
}

function listingDetail() {
	return {
		ok: true,
		listing: { id: 'listing-1', name: '@owner/notes' },
	}
}

test('loadPackagePage applies the owner / community / public visibility matrix', async () => {
	mockModule.loadViewerPackageShare.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.resolvePackagePageUrl.mockResolvedValue(null)
	await expect(
		loadPackagePage({ env, request, username: 'owner', kodyId: 'missing' }),
	).resolves.toEqual({ kind: 'not_found' })

	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicSavedPackage({ hidden: true }),
		listingId: null,
	})
	await expect(
		loadPackagePage({ env, request, username: 'owner', kodyId: 'notes' }),
	).resolves.toEqual({ kind: 'not_found' })

	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicSavedPackage({ isPrivate: true }),
		listingId: null,
	})
	await expect(
		loadPackagePage({ env, request, username: 'owner', kodyId: 'notes' }),
	).resolves.toEqual({ kind: 'not_found' })

	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicSavedPackage(),
		listingId: null,
	})
	await expect(
		loadPackagePage({ env, request, username: 'owner', kodyId: 'notes' }),
	).resolves.toEqual({ kind: 'unauthorized' })

	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail())
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicSavedPackage(),
		listingId: 'listing-1',
	})
	const listed = await loadPackagePage({
		env,
		request,
		username: 'owner',
		kodyId: 'notes',
	})
	expect(listed).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		listing: { listing: { id: 'listing-1' } },
		ownerPackage: null,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser())
	mockModule.loadAccountPackageDetail.mockResolvedValue({
		id: 'pkg-1',
		name: '@owner/notes',
		kodyId: 'notes',
	})
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicSavedPackage({ hidden: true }),
		listingId: null,
	})
	const ownerHidden = await loadPackagePage({
		env,
		request,
		username: 'owner',
		kodyId: 'notes',
	})
	expect(ownerHidden).toMatchObject({
		kind: 'page',
		viewerIsOwner: true,
		ownerPackage: { id: 'pkg-1' },
		listing: null,
	})

	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'redirect',
		username: 'owner',
		kodyId: 'renamed',
		userId: 'owner-1',
		listingId: null,
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	await expect(
		loadPackagePage({ env, request, username: 'owner', kodyId: 'old' }),
	).resolves.toEqual({ kind: 'not_found' })

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser())
	await expect(
		loadPackagePage({ env, request, username: 'owner', kodyId: 'old' }),
	).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/renamed',
		shared: false,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'redirect',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		listingId: 'listing-1',
	})
	await expect(
		loadPackagePage({ env, request, username: 'old', kodyId: 'notes' }),
	).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes',
		shared: true,
	})
})

test('loadPackagePage does not send anonymous visitors to an unpublished listing rename', async () => {
	const listingLagPackage = {
		id: 'pkg-1',
		kodyId: 'notes-two',
		hidden: false,
		isPrivate: false,
	}
	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail())
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: listingLagPackage,
		listingId: 'listing-1',
		listingKodyId: 'notes',
	})
	const anonymousListing = await loadPackagePage({
		env,
		request,
		username: 'owner',
		kodyId: 'notes',
	})
	expect(anonymousListing).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		listing: { listing: { id: 'listing-1' } },
	})
	expect(anonymousListing).not.toMatchObject({
		kind: 'redirect',
		to: '/@owner/notes-two',
	})

	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes-two',
		userId: 'owner-1',
		savedPackage: listingLagPackage,
		listingId: 'listing-1',
		listingKodyId: 'notes',
	})
	await expect(
		loadPackagePage({
			env,
			request,
			username: 'owner',
			kodyId: 'notes-two',
		}),
	).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes',
		shared: true,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser())
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: listingLagPackage,
		listingId: 'listing-1',
		listingKodyId: 'notes',
	})
	await expect(
		loadPackagePage({
			env,
			request,
			username: 'owner',
			kodyId: 'notes',
		}),
	).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes-two',
		shared: false,
	})
})

test('loadPackagePage lets pending and accepted share guests see a private package', async () => {
	mockModule.loadCommunityDetailData.mockResolvedValue(null)
	mockModule.loadAccountPackageDetail.mockResolvedValue({
		id: 'pkg-1',
		name: '@owner/notes',
		kodyId: 'notes',
		isPrivate: true,
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'guest@example.com',
		mcpUser: { userId: 'guest-1' },
	})
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'notes',
		userId: 'owner-1',
		savedPackage: publicSavedPackage({ isPrivate: true }),
		listingId: null,
	})
	mockModule.loadViewerPackageShare.mockResolvedValue({
		id: 'grant-1',
		status: 'pending',
		packageName: '@owner/notes',
	})
	const pending = await loadPackagePage({
		env,
		request,
		username: 'owner',
		kodyId: 'notes',
	})
	expect(pending).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		loggedIn: true,
		ownerPackage: null,
		canReadOwnerSource: false,
		shareGrant: { id: 'grant-1', status: 'pending' },
	})

	mockModule.loadViewerPackageShare.mockResolvedValue({
		id: 'grant-1',
		status: 'accepted',
		packageName: '@owner/notes',
	})
	const accepted = await loadPackagePage({
		env,
		request,
		username: 'owner',
		kodyId: 'notes',
	})
	expect(accepted).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		ownerPackage: { id: 'pkg-1' },
		canReadOwnerSource: true,
		shareGrant: { id: 'grant-1', status: 'accepted' },
	})
})
