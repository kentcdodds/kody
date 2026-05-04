import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceRepo: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', async () => {
	const actual = await vi.importActual('#worker/repo/artifacts.ts')
	return {
		...(actual as object),
		resolveArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceRepo(...args),
	}
})

const { getGitRemoteCapability } = await import('./get-git-remote.ts')

function createContext(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: `${userId}@example.com`,
				displayName: userId,
			},
			homeConnectorId: null,
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
	mockModule.getEntitySourceById.mockResolvedValue({
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
	})
	const createToken = vi.fn(async (scope: 'read' | 'write', ttl: number) => ({
		id: 'token-1',
		plaintext: `art_v1_${scope}_token?expires=${Math.floor(Date.now() / 1000) + ttl}`,
		scope,
		expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
	}))
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/package-package-1.git',
			defaultBranch: 'main',
		})),
		createToken,
	})
	return { createToken }
}

beforeEach(() => {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
})

test('returns a write remote token expiring within the requested ttl', async () => {
	const { createToken } = mockPackageSource()
	const before = Date.now()
	const result = await getGitRemoteCapability.handler(
		{ package_id: 'package-1', ttl_seconds: 1800 },
		createContext(),
	)
	const expiresAt = new Date(result.expires_at).getTime()
	expect(createToken).toHaveBeenCalledWith('write', 1800)
	expect(result.scope).toBe('write')
	expect(expiresAt).toBeGreaterThanOrEqual(before + 1799 * 1000)
	expect(expiresAt).toBeLessThanOrEqual(Date.now() + 1801 * 1000)
	expect(result.authenticated_remote).toContain('https://x:art_v1_write_token@')
	expect(result.git_extra_header).toBe(
		'Authorization: Bearer art_v1_write_token',
	)
	expect(result.setup_commands[0]).toContain('-c http.extraHeader=')
})

test('rejects a package source owned by another user', async () => {
	mockPackageSource('other-user')
	await expect(
		getGitRemoteCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		),
	).rejects.toThrow('Repo source was not found for this user.')
})

test('rejects an unknown package id', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(null)
	await expect(
		getGitRemoteCapability.handler({ package_id: 'missing' }, createContext()),
	).rejects.toThrow('Saved package "missing" was not found.')
})

test('requires exactly one package identity', async () => {
	await expect(
		getGitRemoteCapability.handler({}, createContext()),
	).rejects.toThrow('Provide exactly one of `package_id` or `kody_id`.')
})

test('honors explicit read scope', async () => {
	const { createToken } = mockPackageSource()
	const result = await getGitRemoteCapability.handler(
		{ kody_id: 'unleashed-wifi', scope: 'read' },
		createContext(),
	)
	expect(createToken).toHaveBeenCalledWith('read', 1800)
	expect(result.scope).toBe('read')
})

test('validates ttl bounds', async () => {
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
