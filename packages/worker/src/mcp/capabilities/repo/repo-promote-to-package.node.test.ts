import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	resolveOwnedUserRepo: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	readArtifactFileAtCommit: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	insertSavedPackage: vi.fn(),
	assertWithinEntitlement: vi.fn(),
	repoSessionRpc: vi.fn(),
	updateEntitySource: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	deleteUserRepo: vi.fn(),
	publishCommunityListing: vi.fn(),
}))

vi.mock('./resolve-user-repo.ts', () => ({
	resolveOwnedUserRepo: (...args: Array<unknown>) =>
		mockModule.resolveOwnedUserRepo(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactFileAtCommit(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	insertSavedPackage: (...args: Array<unknown>) =>
		mockModule.insertSavedPackage(...args),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	assertWithinEntitlement: (...args: Array<unknown>) =>
		mockModule.assertWithinEntitlement(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('#worker/package-registry/vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	deleteUserRepo: (...args: Array<unknown>) =>
		mockModule.deleteUserRepo(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: (...args: Array<unknown>) =>
		mockModule.publishCommunityListing(...args),
}))

const { repoPromoteToPackageCapability } =
	await import('./repo-promote-to-package.ts')

const packageJson = JSON.stringify({
	name: '@user/brave-search',
	exports: { '.': './src/index.ts' },
	kody: {
		id: 'brave-search',
		description: 'Search the web with Brave.',
	},
})

function createPlainRepoSource() {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'repo' as const,
		entity_id: 'repo-1',
		repo_id: 'repo-artifacts-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	}
}

function createCapabilityContext() {
	const deleted: Array<Array<unknown>> = []
	return {
		deleted,
		ctx: {
			env: {
				APP_DB: {
					prepare(sql: string) {
						return {
							bind(...values: Array<unknown>) {
								return {
									run: async () => {
										deleted.push([sql, ...values])
										return { meta: { changes: 1 } }
									},
								}
							},
						}
					},
				} as unknown as D1Database,
			} as Env,
			callerContext: createMcpCallerContext({
				user: {
					userId: 'user-1',
					email: 'user@test.invalid',
					username: 'user',
				},
				baseUrl: 'https://kody.test',
			}),
		},
	}
}

function createSessionRpc(overrides?: {
	checkOk?: boolean
	publish?: {
		status: 'ok' | 'base_moved' | 'checks_outdated'
		publishedCommit?: string | null
		message?: string
	}
}) {
	return {
		openSession: vi.fn(async () => ({
			id: 'repo-promote-source-1-test',
			base_commit: 'commit-1',
		})),
		runChecks: vi.fn(async () => ({
			ok: overrides?.checkOk ?? true,
			results:
				overrides?.checkOk === false
					? [{ kind: 'manifest', ok: false, message: 'Manifest invalid.' }]
					: [
							{
								kind: 'manifest',
								ok: true,
								message: 'Validated package.json.',
							},
						],
		})),
		publishSession: vi.fn(async () => ({
			status: overrides?.publish?.status ?? 'ok',
			sessionId: 'repo-promote-source-1-test',
			publishedCommit: overrides?.publish?.publishedCommit ?? 'commit-1',
			message:
				overrides?.publish?.message ?? 'Published session to repo-artifacts-1.',
		})),
		discardSession: vi.fn(async () => ({
			ok: true,
			sessionId: 'repo-promote-source-1-test',
			deleted: true,
		})),
	}
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.resolveOwnedUserRepo.mockResolvedValue({
		userRepo: {
			id: 'repo-1',
			userId: 'user-1',
			name: 'brave-search',
			description: null,
			isPrivate: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		source: createPlainRepoSource(),
	})
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-1',
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode(packageJson),
	)
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.insertSavedPackage.mockResolvedValue(undefined)
	mockModule.assertWithinEntitlement.mockResolvedValue(undefined)
	mockModule.updateEntitySource.mockResolvedValue(true)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.refreshSavedPackageProjection.mockResolvedValue({ record: {} })
	mockModule.deleteUserRepo.mockResolvedValue(undefined)
	mockModule.publishCommunityListing.mockResolvedValue({ id: 'listing-1' })
}

test('repoPromoteToPackage rejects repos without package.json at HEAD', async () => {
	resetMocks()
	mockModule.readArtifactFileAtCommit.mockResolvedValueOnce(null)
	const { ctx } = createCapabilityContext()
	await expect(
		repoPromoteToPackageCapability.handler({ name: 'brave-search' }, ctx),
	).rejects.toThrow(McpCallerError)
	expect(mockModule.repoSessionRpc).not.toHaveBeenCalled()
})

test('repoPromoteToPackage seeds published_commit from the opened session base so publish is not treated as a stale session', async () => {
	resetMocks()
	// HEAD snapshot can lag a concurrent git-lane push; the opened session
	// base is the commit publishSession will compare against.
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-stale',
	})
	const rpc = createSessionRpc()
	rpc.openSession.mockResolvedValue({
		id: 'repo-promote-source-1-test',
		base_commit: 'commit-1',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	const { ctx } = createCapabilityContext()

	const result = await repoPromoteToPackageCapability.handler(
		{ name: 'brave-search' },
		ctx,
	)

	expect(result).toMatchObject({
		status: 'promoted',
		kody_id: 'brave-search',
		name: '@user/brave-search',
		published_commit: 'commit-1',
	})
	expect(result).not.toHaveProperty('message')
	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			is_private: 0,
			kody_id: 'brave-search',
		}),
	)
	expect(rpc.runChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			expectedPackageScope: 'user',
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			entityKind: 'package',
			manifestPath: 'package.json',
			publishedCommit: 'commit-1',
		}),
	)
	expect(rpc.publishSession).toHaveBeenCalled()
	expect(mockModule.publishCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId: result.package_id,
			userId: 'user-1',
		}),
	)
	expect(mockModule.deleteUserRepo).toHaveBeenCalledWith(expect.anything(), {
		userId: 'user-1',
		repoId: 'repo-1',
	})
})

test('repoPromoteToPackage inherits repo visibility, not package.json private', async () => {
	resetMocks()
	mockModule.resolveOwnedUserRepo.mockResolvedValue({
		userRepo: {
			id: 'repo-1',
			userId: 'user-1',
			name: 'brave-search',
			description: null,
			isPrivate: true,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		source: createPlainRepoSource(),
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode(
			JSON.stringify({
				name: '@user/brave-search',
				private: false,
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'brave-search',
					description: 'Search the web with Brave.',
				},
			}),
		),
	)
	const rpc = createSessionRpc()
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	const { ctx } = createCapabilityContext()

	await repoPromoteToPackageCapability.handler({ name: 'brave-search' }, ctx)

	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			is_private: 1,
		}),
	)
	expect(mockModule.publishCommunityListing).not.toHaveBeenCalled()
})

test('repoPromoteToPackage rolls back the kind flip and published_commit when publish reports base_moved', async () => {
	resetMocks()
	const rpc = createSessionRpc({
		publish: {
			status: 'base_moved',
			publishedCommit: null,
			message:
				'The source repo has moved since this session opened. Rebase the session before publishing.',
		},
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	const { ctx, deleted } = createCapabilityContext()

	await expect(
		repoPromoteToPackageCapability.handler({ name: 'brave-search' }, ctx),
	).rejects.toThrow(/source repo has moved/)

	expect(mockModule.updateEntitySource).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({
			entityKind: 'package',
			publishedCommit: 'commit-1',
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			entityKind: 'repo',
			entityId: 'repo-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
			publishedCommit: null,
		}),
	)
	expect(deleted[0]?.[0]).toMatch(/DELETE FROM saved_packages/)
	expect(rpc.discardSession).toHaveBeenCalled()
	expect(mockModule.deleteUserRepo).not.toHaveBeenCalled()
})

test('repoPromoteToPackage still finishes when community listing publish fails', async () => {
	resetMocks()
	mockModule.publishCommunityListing.mockRejectedValue(
		new Error('listing failed'),
	)
	const rpc = createSessionRpc()
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	const { ctx } = createCapabilityContext()

	const result = await repoPromoteToPackageCapability.handler(
		{ name: 'brave-search' },
		ctx,
	)

	expect(result).toMatchObject({
		status: 'promoted',
		kody_id: 'brave-search',
		published_commit: 'commit-1',
	})
	expect(result.message).toContain('listing failed')
	expect(result.message).toContain('communityPublish')
	expect(result.message).toContain(result.package_id)
	expect(mockModule.deleteUserRepo).toHaveBeenCalledWith(expect.anything(), {
		userId: 'user-1',
		repoId: 'repo-1',
	})
})
