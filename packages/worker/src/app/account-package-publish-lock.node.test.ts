import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	setSavedPackageLockedAt: vi.fn(),
	loadAccountPackagesData: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	loadPublicTreeFiles: vi.fn(async () => ({
		files: {},
		fromListingSnapshot: false,
	})),
	readArtifactTreeAtCommit: vi.fn(async () => ({})),
	getAppBaseUrl: () => 'https://example.com',
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	setSavedPackageLockedAt: (...args: Array<unknown>) =>
		mockModule.setSavedPackageLockedAt(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackagesData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackagesData(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadPublicTreeFiles: (...args: Array<unknown>) =>
		mockModule.loadPublicTreeFiles(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactTreeAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactTreeAtCommit(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mockModule.publishFromExternalRef(...args),
	}),
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

const {
	handleAccountPackagePublishLockAction,
	loadAccountPackageApprovePublishData,
} = await import('./account-package-publish-lock.ts')

const user = {
	email: 'user@example.com',
	username: 'user',
	mcpUser: {
		userId: 'user-1',
		email: 'user@example.com',
		username: 'user',
		displayName: 'User',
	},
}

const unlockedPackage = {
	id: 'pkg-1',
	userId: 'user-1',
	name: '@user/notes',
	kodyId: 'notes',
	description: 'Notes',
	tags: [],
	searchText: null,
	sourceId: 'source-1',
	hasApp: false,
	hidden: false,
	isPrivate: false,
	lockedAt: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-01T00:00:00.000Z',
}

const lockedPackage = {
	...unlockedPackage,
	lockedAt: '2026-08-28T12:00:00.000Z',
}

const packagesPayload = {
	ok: true,
	email: 'user@example.com',
	username: 'user',
	invocationUrlOrigin: 'https://example.com',
	packages: [],
	selectedPackage: null,
	page: 1,
	pageSize: 20,
	total: 0,
	query: '',
	appFilter: 'all',
	sort: 'updated',
}

function createRequest() {
	return new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
}

test('website lock and unlock write locked_at and approve-publish promotes a named commit without unlocking', async () => {
	mockModule.loadAccountPackagesData.mockResolvedValue(packagesPayload)
	mockModule.getSavedPackageById.mockResolvedValue(unlockedPackage)
	mockModule.setSavedPackageLockedAt.mockResolvedValue(true)

	const ignored = await handleAccountPackagePublishLockAction({
		env: { APP_DB: {} } as Env,
		request: createRequest(),
		user: user as never,
		body: { action: 'absorb-listing', packageId: 'pkg-1' },
	})
	expect(ignored).toBeNull()
	expect(mockModule.setSavedPackageLockedAt).not.toHaveBeenCalled()

	const lockResponse = await handleAccountPackagePublishLockAction({
		env: { APP_DB: {} } as Env,
		request: createRequest(),
		user: user as never,
		body: { action: 'lock', packageId: 'pkg-1' },
	})
	expect(lockResponse?.status).toBe(200)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			userId: 'user-1',
			packageId: 'pkg-1',
		}),
	)
	const lockInput = mockModule.setSavedPackageLockedAt.mock.calls[0]?.[1] as {
		lockedAt: string | null
	}
	expect(lockInput.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

	mockModule.getSavedPackageById.mockResolvedValue(lockedPackage)
	const alreadyLocked = await handleAccountPackagePublishLockAction({
		env: { APP_DB: {} } as Env,
		request: createRequest(),
		user: user as never,
		body: { action: 'lock', packageId: 'pkg-1' },
	})
	expect(alreadyLocked?.status).toBe(200)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	const unlockResponse = await handleAccountPackagePublishLockAction({
		env: { APP_DB: {} } as Env,
		request: createRequest(),
		user: user as never,
		body: { action: 'unlock', packageId: 'pkg-1' },
	})
	expect(unlockResponse?.status).toBe(200)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenLastCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'pkg-1',
			lockedAt: null,
		},
	)

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		source_root: '/',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'abc1234',
		manifest: {},
		checks: [],
	})
	const approveResponse = await handleAccountPackagePublishLockAction({
		env: { APP_DB: {} } as Env,
		request: createRequest(),
		user: user as never,
		body: {
			action: 'approve-publish',
			packageId: 'pkg-1',
			commit: 'abc1234',
		},
	})
	expect(approveResponse?.status).toBe(200)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'abc1234',
			allowLockedPublish: true,
		}),
	)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(2)

	mockModule.getSavedPackageById.mockResolvedValue(unlockedPackage)
	const unlockedApprove = await handleAccountPackagePublishLockAction({
		env: { APP_DB: {} } as Env,
		request: createRequest(),
		user: user as never,
		body: {
			action: 'approve-publish',
			packageId: 'pkg-1',
			commit: 'abc1234',
		},
	})
	expect(unlockedApprove?.status).toBe(200)
	expect(mockModule.publishFromExternalRef).toHaveBeenLastCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'abc1234',
		}),
	)
	expect(
		mockModule.publishFromExternalRef.mock.calls.at(-1)?.[0],
	).not.toHaveProperty('allowLockedPublish')
	mockModule.getSavedPackageById.mockResolvedValue(lockedPackage)

	mockModule.getSavedPackageById.mockResolvedValue(lockedPackage)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'deadbeef',
	})
	const loaded = await loadAccountPackageApprovePublishData({
		env: { APP_DB: {} } as Env,
		request: new Request(
			'https://example.com/account/packages/pkg-1/approve-publish?commit=abc1234',
		),
		user: user as never,
		packageId: 'pkg-1',
	})
	expect(loaded).toMatchObject({
		ok: true,
		publishedCommit: 'commit-old',
		pendingCommit: 'abc1234',
		alreadyPublished: false,
		packageHref: '/@user/notes',
		package: {
			id: 'pkg-1',
			lockedAt: '2026-08-28T12:00:00.000Z',
		},
		diff: { files: [], omittedCount: 0 },
	})
})

test('approve-publish resolves HEAD, missing published, and missing HEAD diffs', async () => {
	const publishedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const pendingCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	mockModule.getSavedPackageById.mockResolvedValue(unlockedPackage)
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
	})
	mockModule.loadPublicTreeFiles.mockImplementation(
		async (input: { commit: string | null }) => {
			if (input.commit === publishedCommit) {
				return {
					files: { 'README.md': '# published\n' },
					fromListingSnapshot: false,
				}
			}
			return { files: {}, fromListingSnapshot: false }
		},
	)
	mockModule.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }) => {
			if (input.commit === pendingCommit) {
				return { 'README.md': '# head\n' }
			}
			return {}
		},
	)

	const fromArtifacts = await loadAccountPackageApprovePublishData({
		env: { APP_DB: {} } as Env,
		request: new Request(
			`https://example.com/account/packages/pkg-1/approve-publish?commit=${pendingCommit}`,
		),
		user: user as never,
		packageId: 'pkg-1',
	})
	expect(fromArtifacts).toMatchObject({
		ok: true,
		publishedCommit,
		pendingCommit,
	})
	if (!fromArtifacts.ok) throw new Error('expected loader success')
	expect(fromArtifacts.diff.files).toEqual([
		{
			path: 'README.md',
			status: 'modified',
			patch: expect.stringContaining('+# head'),
		},
	])
	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'repo-1',
			commit: pendingCommit,
		}),
	)

	mockModule.readArtifactTreeAtCommit.mockRejectedValue(
		new Error('fetch failed'),
	)
	const failedPending = await loadAccountPackageApprovePublishData({
		env: { APP_DB: {} } as Env,
		request: new Request(
			`https://example.com/account/packages/pkg-1/approve-publish?commit=${pendingCommit}`,
		),
		user: user as never,
		packageId: 'pkg-1',
	})
	if (!failedPending.ok) throw new Error('expected loader success')
	expect(failedPending.diff).toEqual({ files: [], omittedCount: 0 })

	mockModule.readArtifactTreeAtCommit.mockReset()
	mockModule.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }) => {
			if (input.commit === publishedCommit) {
				throw new Error('published fetch failed')
			}
			return { 'README.md': '# head\n' }
		},
	)
	mockModule.loadPublicTreeFiles.mockResolvedValue({
		files: {},
		fromListingSnapshot: false,
	})
	const unresolvedPublished = await loadAccountPackageApprovePublishData({
		env: { APP_DB: {} } as Env,
		request: new Request(
			`https://example.com/account/packages/pkg-1/approve-publish?commit=${pendingCommit}`,
		),
		user: user as never,
		packageId: 'pkg-1',
	})
	if (!unresolvedPublished.ok) throw new Error('expected loader success')
	expect(unresolvedPublished.diff).toEqual({ files: [], omittedCount: 0 })

	mockModule.resolveArtifactSourceHead.mockResolvedValue({ commit: null })
	mockModule.loadPublicTreeFiles.mockImplementation(
		async (input: { commit: string | null }) => {
			if (input.commit === publishedCommit) {
				return {
					files: { 'README.md': '# published\n' },
					fromListingSnapshot: false,
				}
			}
			return { files: {}, fromListingSnapshot: false }
		},
	)
	const missingHead = await loadAccountPackageApprovePublishData({
		env: { APP_DB: {} } as Env,
		request: new Request(
			'https://example.com/account/packages/pkg-1/approve-publish',
		),
		user: user as never,
		packageId: 'pkg-1',
	})
	if (!missingHead.ok) throw new Error('expected loader success')
	expect(missingHead.pendingCommit).toBeNull()
	expect(missingHead.diff).toEqual({ files: [], omittedCount: 0 })
})
