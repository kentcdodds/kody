import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageWithCommunityProvenanceById: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageWithCommunityProvenanceById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	packageScopeInputDescription: 'package scope',
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

const { getPackageCapability } = await import('./get-package.ts')

function createCallerContext(input?: {
	username?: string | null
	ownerUserId?: string
	ownerScope?: string
	ownerEmail?: string
	delegated?: boolean
}) {
	const userId = 'user-1'
	const ownerUserId = input?.ownerUserId ?? userId
	const ownerScope = input?.ownerScope ?? input?.username ?? 'kody'
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId,
		ownerScope,
		ownerEmail: input?.ownerEmail ?? 'kody@example.com',
		actorUserId: userId,
		delegated: input?.delegated ?? false,
	})

	const user: {
		userId: string
		email: string
		displayName: string
		username?: string
	} = {
		userId,
		email: 'kody@example.com',
		displayName: 'Kody',
	}
	if (input?.username !== null) {
		user.username = input?.username ?? 'kody'
	}

	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user,
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('getPackageCapability returns export metadata for owner and delegated package scopes', async () => {
	mockModule.getSavedPackageWithCommunityProvenanceById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		isPrivate: false,
		sourceListingId: 'listing-1',
		listingCurrent: true,
		listingKodyId: 'upstream-discord-gateway',
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'.': './src/index.ts',
				'./post-message': {
					import: './src/post-message.ts',
					types: './src/post-message.ts',
				},
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
				tags: ['discord'],
				app: {
					entry: './src/operator-app.ts',
				},
			},
		},
	})

	const withUsername = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext(),
	)

	expect(withUsername).toMatchObject({
		package_id: 'package-1',
		kody_id: 'discord-gateway',
		name: '@kentcdodds/discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		has_app: true,
		source_id: 'source-1',
		source_listing_id: 'listing-1',
		listing_current: true,
		listing_kody_id: 'upstream-discord-gateway',
		created_at: '2026-04-25T00:00:00.000Z',
		updated_at: '2026-04-26T00:00:00.000Z',
		exports: [
			{
				subpath: '.',
				import_specifier: 'kody:@kentcdodds/discord-gateway',
				runtime_target: 'src/index.ts',
				external_invocation: {
					method: 'POST',
					url: 'https://heykody.dev/@kody/api/package-invocations/discord-gateway/__root__',
					path: '/@kody/api/package-invocations/discord-gateway/__root__',
					owner_username: 'kody',
					kody_id: 'discord-gateway',
					route_export_name: '__root__',
					normalized_export_name: '.',
					token_setup_url:
						'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=.',
					source_guidance: expect.any(String),
				},
			},
			{
				subpath: './post-message',
				import_specifier: 'kody:@kentcdodds/discord-gateway/post-message',
				runtime_target: 'src/post-message.ts',
				types_path: 'src/post-message.ts',
				external_invocation: {
					method: 'POST',
					url: 'https://heykody.dev/@kody/api/package-invocations/discord-gateway/post-message',
					path: '/@kody/api/package-invocations/discord-gateway/post-message',
					owner_username: 'kody',
					kody_id: 'discord-gateway',
					route_export_name: 'post-message',
					normalized_export_name: './post-message',
					token_setup_url:
						'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=post-message',
					source_guidance: expect.any(String),
				},
			},
		],
	})
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'user-1', packageId: 'package-1' }),
	)
	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-1',
	})

	// Delegated package_scope loads and builds invocation URLs for the owner.
	mockModule.getSavedPackageWithCommunityProvenanceById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.resolvePackageOwnerContext.mockClear()
	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: 'platform-owner',
		name: '@kody/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		sourceListingId: null,
		listingCurrent: null,
		listingKodyId: null,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kody/discord-gateway',
			exports: {
				'./post-message': './src/post-message.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
			},
		},
	})

	const delegated = await getPackageCapability.handler(
		{ package_id: 'package-1', package_scope: 'kody' },
		createCallerContext({
			ownerUserId: 'platform-owner',
			ownerScope: 'kody',
			ownerEmail: 'platform@example.com',
			delegated: true,
		}),
	)

	expect(mockModule.resolvePackageOwnerContext).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'user-1' }),
		'kody',
	)
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: 'platform-owner',
			packageId: 'package-1',
		}),
	)
	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'platform-owner' }),
	)
	expect(delegated.exports[0]?.external_invocation).toMatchObject({
		owner_username: 'kody',
		url: 'https://heykody.dev/@kody/api/package-invocations/discord-gateway/post-message',
	})
})
