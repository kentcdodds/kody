import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	resolveArtifactDefaultBranchHead: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	createStubSavedPackage: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	packageScopeInputDescription: 'package scope',
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/repo/artifacts.ts', async () => {
	const actual = await vi.importActual('#worker/repo/artifacts.ts')
	return {
		...(actual as object),
		resolveArtifactDefaultBranchHead: (...args: Array<unknown>) =>
			mockModule.resolveArtifactDefaultBranchHead(...args),
		resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveExistingArtifactSourceRepo(...args),
	}
})

vi.mock('./create-stub-package.ts', () => ({
	createStubSavedPackage: (...args: Array<unknown>) =>
		mockModule.createStubSavedPackage(...args),
}))

const { getGitRemoteCapability } = await import('./get-git-remote.ts')

function personalOwner(userId = 'user-1') {
	return {
		ownerUserId: userId,
		ownerScope: 'kentcdodds',
		ownerEmail: `${userId}@example.com`,
		actorUserId: userId,
		delegated: false,
	}
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.resolvePackageOwnerContext.mockResolvedValue(personalOwner())
}

function createContext(userId = 'user-1') {
	return {
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {
				async get(_key: string, type?: 'text' | 'json') {
					if (type !== 'json') return null
					return {
						version: 1,
						sourceId: 'source-1',
						repoId: 'package-package-1',
						entityKind: 'package',
						entityId: 'package-1',
						publishedCommit: 'commit-1',
						manifestPath: 'package.json',
						sourceRoot: '/',
						files: {
							'package.json': JSON.stringify({
								name: '@kentcdodds/unleashed-wifi',
								exports: { '.': './src/index.ts' },
								kody: {
									id: 'unleashed-wifi',
									description: 'Unleashed WiFi controls.',
								},
							}),
							'src/index.ts': 'export default async function main() {}\n',
						},
						createdAt: '2026-05-04T00:00:00.000Z',
					}
				},
			},
		} as unknown as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: `${userId}@example.com`,
				displayName: userId,
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

function mockPackageSource(sourceUserId = 'user-1') {
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'unleashed-wifi',
		name: '@kentcdodds/unleashed-wifi',
		sourceId: 'source-1',
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValue({
		id: 'package-1',
		kodyId: 'unleashed-wifi',
		name: '@kentcdodds/unleashed-wifi',
		sourceId: 'source-1',
	})
	mockModule.getEntitySourceByIdForUser.mockImplementation(
		async (_db: unknown, input: { id: string; userId: string }) => {
			if (input.userId !== sourceUserId) return null
			return {
				id: 'source-1',
				user_id: sourceUserId,
				entity_kind: 'package',
				entity_id: 'package-1',
				repo_id: 'package-package-1',
				published_commit: 'commit-1',
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				last_external_check_at: null,
				created_at: '2026-05-04T00:00:00.000Z',
				updated_at: '2026-05-04T00:00:00.000Z',
			}
		},
	)
	const createToken = vi.fn(async (scope: 'read' | 'write', ttl: number) => ({
		id: 'token-1',
		plaintext: `art_v1_${scope}_token?expires=${Math.floor(Date.now() / 1000) + ttl}`,
		scope,
		expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
	}))
	const repo = {
		info: vi.fn(async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-package-1.git',
			defaultBranch: 'main',
		})),
		createToken,
	}
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue(repo)
	mockModule.resolveArtifactDefaultBranchHead.mockResolvedValue({
		remote:
			'https://acct.artifacts.cloudflare.net/git/default/package-package-1.git',
		defaultBranch: 'main',
		commit: 'commit-1',
	})
	return { createToken }
}

test('get_git_remote returns scoped artifact remotes and rejects invalid input', async () => {
	resetMocks()
	await expect(
		getGitRemoteCapability.handler({}, createContext()),
	).rejects.toThrow('Provide exactly one of `package_id` or `kody_id`.')

	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue(null)
	await expect(
		getGitRemoteCapability.handler({ package_id: 'missing' }, createContext()),
	).rejects.toThrow('Saved package "missing" was not found.')

	resetMocks()
	mockPackageSource('other-user')
	await expect(
		getGitRemoteCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		),
	).rejects.toThrow('Repo source was not found for this user.')

	resetMocks()
	const { createToken } = mockPackageSource()
	const before = Date.now()
	const writeResult = await getGitRemoteCapability.handler(
		{ package_id: 'package-1', ttl_seconds: 1800 },
		createContext(),
	)
	const writeExpiresAt = new Date(writeResult.expires_at).getTime()
	expect(createToken).toHaveBeenCalledWith('write', 1800)
	expect(writeResult.scope).toBe('write')
	expect(writeExpiresAt).toBeGreaterThanOrEqual(before + 1799 * 1000)
	expect(writeExpiresAt).toBeLessThanOrEqual(Date.now() + 1801 * 1000)
	expect(writeResult.authenticated_remote).toContain(
		'https://x:art_v1_write_token@',
	)
	expect(writeResult.git_extra_header).toBe(
		'Authorization: Bearer art_v1_write_token',
	)
	expect(writeResult.setup_commands.length).toBeGreaterThan(0)
	expect(writeResult.setup_commands[0]).toMatch(/^git -c http\.extraHeader=/)

	resetMocks()
	const readSetup = mockPackageSource()
	const readResult = await getGitRemoteCapability.handler(
		{ kody_id: 'unleashed-wifi', scope: 'read' },
		createContext(),
	)
	expect(readSetup.createToken).toHaveBeenCalledWith('read', 14_400)
	expect(readResult.scope).toBe('read')

	resetMocks()
	mockPackageSource()
	await expect(
		getGitRemoteCapability.handler(
			{ package_id: 'package-1', ttl_seconds: 59 },
			createContext(),
		),
	).rejects.toThrow()
	await expect(
		getGitRemoteCapability.handler(
			{ package_id: 'package-1', ttl_seconds: 86_401 },
			createContext(),
		),
	).rejects.toThrow()
})

test('get_git_remote create mode registers stubs for owner and delegated scopes', async () => {
	resetMocks()
	await expect(
		getGitRemoteCapability.handler(
			{ package_id: 'package-1', create: true },
			createContext(),
		),
	).rejects.toThrow(
		'`create: true` requires `kody_id` (without `package_id`); new package ids are generated by Kody.',
	)
	await expect(
		getGitRemoteCapability.handler({ create: true }, createContext()),
	).rejects.toThrow(
		'`create: true` requires `kody_id` (without `package_id`); new package ids are generated by Kody.',
	)
	expect(mockModule.createStubSavedPackage).not.toHaveBeenCalled()

	resetMocks()
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(null)
	mockModule.createStubSavedPackage.mockImplementation(async () => {
		mockPackageSource()
		return {
			packageId: 'package-1',
			kodyId: 'unleashed-wifi',
			name: '@kentcdodds/unleashed-wifi',
		}
	})
	const createdResult = await getGitRemoteCapability.handler(
		{ kody_id: 'unleashed-wifi', create: true, description: 'WiFi controls' },
		createContext(),
	)
	expect(mockModule.createStubSavedPackage).toHaveBeenCalledWith(
		expect.objectContaining({
			kodyId: 'unleashed-wifi',
			description: 'WiFi controls',
			baseUrl: 'https://heykody.dev',
			owner: personalOwner(),
		}),
	)
	expect(createdResult.created).toBe(true)
	expect(createdResult.package_id).toBe('package-1')
	expect(createdResult.kody_id).toBe('unleashed-wifi')
	expect(createdResult.setup_commands.length).toBeGreaterThan(0)

	resetMocks()
	mockPackageSource()
	const existingResult = await getGitRemoteCapability.handler(
		{ kody_id: 'unleashed-wifi', create: true },
		createContext(),
	)
	expect(mockModule.createStubSavedPackage).not.toHaveBeenCalled()
	expect(existingResult.created).toBe(false)
	expect(existingResult.package_id).toBe('package-1')

	resetMocks()
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(null)
	mockModule.createStubSavedPackage.mockImplementation(async () => {
		mockPackageSource()
		return {
			packageId: 'package-1',
			kodyId: 'unleashed-wifi',
			name: '@kentcdodds/unleashed-wifi',
		}
	})
	const trimmedResult = await getGitRemoteCapability.handler(
		{ kody_id: '  unleashed-wifi  ', create: true },
		createContext(),
	)
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({ kodyId: 'unleashed-wifi' }),
	)
	expect(mockModule.createStubSavedPackage).toHaveBeenCalledWith(
		expect.objectContaining({ kodyId: 'unleashed-wifi' }),
	)
	expect(trimmedResult.created).toBe(true)
	expect(trimmedResult.kody_id).toBe('unleashed-wifi')

	resetMocks()
	const delegatedOwner = {
		ownerUserId: 'platform-owner',
		ownerScope: 'kody',
		ownerEmail: 'kody@example.com',
		actorUserId: 'user-1',
		delegated: true,
	}
	mockModule.resolvePackageOwnerContext.mockResolvedValue(delegatedOwner)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(null)
	mockModule.createStubSavedPackage.mockImplementation(async () => {
		mockPackageSource('platform-owner')
		return {
			packageId: 'package-1',
			kodyId: 'unleashed-wifi',
			name: '@kody/unleashed-wifi',
		}
	})
	const delegatedResult = await getGitRemoteCapability.handler(
		{
			kody_id: 'unleashed-wifi',
			create: true,
			package_scope: 'kody',
		},
		createContext('user-1'),
	)
	expect(mockModule.resolvePackageOwnerContext).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'user-1' }),
		'kody',
	)
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({
			userId: 'platform-owner',
			kodyId: 'unleashed-wifi',
		}),
	)
	expect(mockModule.createStubSavedPackage).toHaveBeenCalledWith(
		expect.objectContaining({
			owner: delegatedOwner,
			kodyId: 'unleashed-wifi',
		}),
	)
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.objectContaining({
			userId: 'platform-owner',
			kodyId: 'unleashed-wifi',
		}),
	)
	expect(delegatedResult.created).toBe(true)
	expect(delegatedResult.package_id).toBe('package-1')
})
