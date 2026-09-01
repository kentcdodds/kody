import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as secretService from '#mcp/secrets/service.ts'
import { type SecretMetadata } from '#mcp/secrets/types.ts'
import { secretListCapability } from './secret-list.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getCommunityForkByForkedPackageId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityForkByForkedPackageId: (...args: Array<unknown>) =>
		mockModule.getCommunityForkByForkedPackageId(...args),
}))

const savedPackage = {
	id: 'pkg-1',
	kodyId: 'web-search',
	name: '@user/web-search',
	sourceId: 'source-1',
}

const communityFork = {
	id: 'fork-1',
	listingId: 'listing-1',
	forkerUserId: 'user-1',
	originCommit: 'abc123',
	forkedPackageId: 'pkg-1',
	forkedSourceId: 'source-1',
	targetKodyId: 'web-search',
	createdAt: '2026-01-01T00:00:00.000Z',
	adoptedAt: null,
	adoptionNote: null,
}

function secretMetadata(
	overrides: Partial<SecretMetadata> & Pick<SecretMetadata, 'name' | 'scope'>,
): SecretMetadata {
	return {
		description: '',
		packageId: overrides.scope === 'package' ? 'pkg-1' : null,
		allowedHosts: [],
		allowedPackages: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
		...overrides,
	}
}

const listedSecrets = [
	secretMetadata({ name: 'BraveSearch', scope: 'user' }),
	secretMetadata({
		name: 'GrantedSearch',
		scope: 'user',
		allowedPackages: ['pkg-1'],
	}),
	secretMetadata({ name: 'packageToken', scope: 'package' }),
]

test('secretList matches implicit user-secret read access and still lists package secrets', async () => {
	const listSecretsSpy = vi
		.spyOn(secretService, 'listSecrets')
		.mockResolvedValue(listedSecrets)
	const env = { APP_DB: {} } as Env
	const executeContext = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: { userId: 'user-1' },
		}),
	}
	const packageContext = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: { userId: 'user-1' },
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
		}),
	}

	const executeListed = await secretListCapability.handler({}, executeContext)
	expect(executeListed.secrets.map((secret) => secret.name)).toEqual([
		'BraveSearch',
		'GrantedSearch',
		'packageToken',
	])
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(null)
	const selfAuthoredListed = await secretListCapability.handler(
		{},
		packageContext,
	)
	expect(selfAuthoredListed.secrets.map((secret) => secret.name)).toEqual([
		'BraveSearch',
		'GrantedSearch',
		'packageToken',
	])

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce({
		...communityFork,
		adoptedAt: '2026-07-01T00:00:00.000Z',
		adoptionNote: 'Reviewed source; trusted for my use.',
	})
	const adoptedListed = await secretListCapability.handler({}, packageContext)
	expect(adoptedListed.secrets.map((secret) => secret.name)).toEqual([
		'BraveSearch',
		'GrantedSearch',
		'packageToken',
	])

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(
		communityFork,
	)
	const unadoptedListed = await secretListCapability.handler({}, packageContext)
	expect(unadoptedListed.secrets.map((secret) => secret.name)).toEqual([
		'GrantedSearch',
		'packageToken',
	])

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	const missingPackageListed = await secretListCapability.handler(
		{},
		packageContext,
	)
	expect(missingPackageListed.secrets.map((secret) => secret.name)).toEqual([
		'GrantedSearch',
		'packageToken',
	])
	expect(listSecretsSpy).toHaveBeenCalled()
	listSecretsSpy.mockRestore()
})
