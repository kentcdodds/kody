import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	setSavedPackageLockedAt: vi.fn(),
	loadAccountPackagesData: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	loadPublicTreeFiles: vi.fn(async (_input: { commit: string | null }) => ({
		files: {} as Record<string, string>,
		fromListingSnapshot: false,
	})),
	readArtifactTreeAtCommit: vi.fn(
		async (_input: { commit: string }): Promise<Record<string, string>> => ({}),
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mockModule.getSavedPackageById,
	setSavedPackageLockedAt: mockModule.setSavedPackageLockedAt,
}))
vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackagesData: mockModule.loadAccountPackagesData,
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))
vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: mockModule.resolveArtifactSourceHead,
}))
vi.mock('#app/package-files-data.ts', () => ({
	loadPublicTreeFiles: mockModule.loadPublicTreeFiles,
}))
vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactTreeAtCommit: mockModule.readArtifactTreeAtCommit,
}))
vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: mockModule.publishFromExternalRef,
	}),
}))
vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => 'https://example.com',
}))

const {
	handleAccountPackagePublishLockAction,
	loadAccountPackageApprovePublishData,
} = await import('./account-package-publish-lock.ts')

type ActionInput = Parameters<typeof handleAccountPackagePublishLockAction>[0]

const env = { APP_DB: {} as D1Database } as Env
const user = {
	email: 'user@example.com',
	username: 'user',
	mcpUser: {
		userId: 'user-1',
		email: 'user@example.com',
		username: 'user',
		displayName: 'User',
	},
} as ActionInput['user']

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

function sourceRow(publishedCommit: string) {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
	}
}

function act(body: ActionInput['body']) {
	return handleAccountPackagePublishLockAction({
		env,
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
		}),
		user,
		body,
	})
}

function loadApprove(commit?: string) {
	const query = commit ? `?commit=${commit}` : ''
	return loadAccountPackageApprovePublishData({
		env,
		request: new Request(
			`https://example.com/@test-user/discord-gateway/approve-publish${query}`,
		),
		user,
		packageId: 'pkg-1',
	})
}

async function loadApproveOk(commit?: string) {
	const loaded = await loadApprove(commit)
	if (!loaded.ok) throw new Error('expected loader success')
	return loaded
}

test('website lock and unlock write locked_at and approve-publish promotes a named commit without unlocking', async () => {
	mockModule.loadAccountPackagesData.mockResolvedValue({
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
	})
	mockModule.getSavedPackageById.mockResolvedValue(unlockedPackage)
	mockModule.setSavedPackageLockedAt.mockResolvedValue(true)

	expect(await act({ action: 'absorb-listing', packageId: 'pkg-1' })).toBeNull()
	expect(mockModule.setSavedPackageLockedAt).not.toHaveBeenCalled()

	const lockResponse = await act({ action: 'lock', packageId: 'pkg-1' })
	expect(lockResponse?.status).toBe(200)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'user-1',
		packageId: 'pkg-1',
		lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
	})

	mockModule.getSavedPackageById.mockResolvedValue(lockedPackage)
	expect((await act({ action: 'lock', packageId: 'pkg-1' }))?.status).toBe(200)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	expect((await act({ action: 'unlock', packageId: 'pkg-1' }))?.status).toBe(
		200,
	)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenLastCalledWith(
		env.APP_DB,
		{ userId: 'user-1', packageId: 'pkg-1', lockedAt: null },
	)

	mockModule.getEntitySourceById.mockResolvedValue(sourceRow('commit-old'))
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'abc1234',
		manifest: {},
		checks: [],
	})
	const approveBody = {
		action: 'approve-publish',
		packageId: 'pkg-1',
		commit: 'abc1234',
	} as const
	expect((await act(approveBody))?.status).toBe(200)
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
	expect((await act(approveBody))?.status).toBe(200)
	const unlockedPublish =
		mockModule.publishFromExternalRef.mock.calls.at(-1)?.[0]
	expect(unlockedPublish).toMatchObject({
		sourceId: 'source-1',
		userId: 'user-1',
		newCommit: 'abc1234',
	})
	expect(unlockedPublish).not.toHaveProperty('allowLockedPublish')

	mockModule.getSavedPackageById.mockResolvedValue(lockedPackage)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'deadbeef',
	})
	expect(await loadApprove('abc1234')).toMatchObject({
		ok: true,
		publishedCommit: 'commit-old',
		pendingCommit: 'abc1234',
		alreadyPublished: false,
		packageHref: '/@user/notes',
		package: { id: 'pkg-1', lockedAt: '2026-08-28T12:00:00.000Z' },
		diff: { files: [], omittedCount: 0 },
	})
})

test('approve-publish resolves HEAD, missing published, and missing HEAD diffs', async () => {
	const publishedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const pendingCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const emptyDiff = { files: [], omittedCount: 0 }
	const publishedReadmeTree = async (input: { commit: string | null }) => ({
		files:
			input.commit === publishedCommit ? { 'README.md': '# published\n' } : {},
		fromListingSnapshot: false,
	})
	mockModule.getSavedPackageById.mockResolvedValue(unlockedPackage)
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(publishedCommit))
	mockModule.loadPublicTreeFiles.mockImplementation(publishedReadmeTree)
	mockModule.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }) =>
			input.commit === pendingCommit ? { 'README.md': '# head\n' } : {},
	)

	const fromArtifacts = await loadApproveOk(pendingCommit)
	expect(fromArtifacts).toMatchObject({ publishedCommit, pendingCommit })
	expect(fromArtifacts.diff.files).toEqual([
		{
			path: 'README.md',
			status: 'modified',
			patch: expect.stringContaining('+# head'),
		},
	])
	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({ repoId: 'repo-1', commit: pendingCommit }),
	)

	mockModule.readArtifactTreeAtCommit.mockRejectedValue(
		new Error('fetch failed'),
	)
	expect((await loadApproveOk(pendingCommit)).diff).toEqual(emptyDiff)

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
	expect((await loadApproveOk(pendingCommit)).diff).toEqual(emptyDiff)

	mockModule.resolveArtifactSourceHead.mockResolvedValue({ commit: null })
	mockModule.loadPublicTreeFiles.mockImplementation(publishedReadmeTree)
	const missingHead = await loadApproveOk()
	expect(missingHead.pendingCommit).toBeNull()
	expect(missingHead.diff).toEqual(emptyDiff)
})
