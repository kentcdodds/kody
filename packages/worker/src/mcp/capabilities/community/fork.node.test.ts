import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	forkCommunityListing: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	forkCommunityListing: (...args: Array<unknown>) =>
		mockModule.forkCommunityListing(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

const { communityForkCapability } = await import('./fork.ts')

function createCallerContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'kody@example.com',
				displayName: 'Kody',
				username: 'kody',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('communityForkCapability passes expectedPackageScope and returns cross_scope_references with next_steps', async () => {
	mockModule.getMcpUserPackageScope.mockReset()
	mockModule.forkCommunityListing.mockReset()
	mockModule.getMcpUserPackageScope.mockResolvedValue('kody')
	mockModule.forkCommunityListing.mockResolvedValue({
		forkId: 'fork-1',
		packageId: 'package-2',
		sourceId: 'source-2',
		targetKodyId: 'forked-package',
		targetName: '@kody/forked-package',
		originCommit: 'commit-abc',
		crossScopeReferences: [
			{ file: 'src/index.ts', specifier: 'kody:@other-user/' },
		],
		filesCount: 3,
	})

	const result = await communityForkCapability.handler(
		{ listing_id: 'listing-1' },
		createCallerContext(),
	)

	expect(mockModule.getMcpUserPackageScope).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'user-1' }),
	)
	expect(mockModule.forkCommunityListing).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		expectedPackageScope: 'kody',
		listingId: 'listing-1',
		kodyId: undefined,
	})
	expect(result).toMatchObject({
		fork_id: 'fork-1',
		package_id: 'package-2',
		source_id: 'source-2',
		cross_scope_references: [
			{ file: 'src/index.ts', specifier: 'kody:@other-user/' },
		],
	})
	expect(result.next_steps).toContain('repo_open_session')
	expect(result.next_steps).toContain('README `## Intent`')
	expect(result.content_warning).toContain('untrusted')
})
