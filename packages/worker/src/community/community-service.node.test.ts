import { expect, test, vi } from 'vitest'
import { type CommunityListingRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	getCommunityBan: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	getCommunityListingById: vi.fn(),
	listAllCommunityListings: vi.fn(),
	getCommunityRatingAggregatesByListingIds: vi.fn(),
	countCommunityForksByListingIds: vi.fn(),
	writeCommunitySnapshot: vi.fn(),
	insertCommunityListing: vi.fn(),
	updateCommunityListing: vi.fn(),
	getCommunityForkByListingAndUser: vi.fn(),
	upsertCommunityRating: vi.fn(),
	insertCommunityReport: vi.fn(),
	getCommunityReportById: vi.fn(),
	readCommunitySnapshot: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getSavedPackageByName: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	insertCommunityFork: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('./repo.ts', () => ({
	getCommunityBan: (...args: Array<unknown>) =>
		mockModule.getCommunityBan(...args),
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
	listAllCommunityListings: (...args: Array<unknown>) =>
		mockModule.listAllCommunityListings(...args),
	getCommunityRatingAggregatesByListingIds: (...args: Array<unknown>) =>
		mockModule.getCommunityRatingAggregatesByListingIds(...args),
	countCommunityForksByListingIds: (...args: Array<unknown>) =>
		mockModule.countCommunityForksByListingIds(...args),
	insertCommunityListing: (...args: Array<unknown>) =>
		mockModule.insertCommunityListing(...args),
	updateCommunityListing: (...args: Array<unknown>) =>
		mockModule.updateCommunityListing(...args),
	getCommunityForkByListingAndUser: (...args: Array<unknown>) =>
		mockModule.getCommunityForkByListingAndUser(...args),
	upsertCommunityRating: (...args: Array<unknown>) =>
		mockModule.upsertCommunityRating(...args),
	insertCommunityReport: (...args: Array<unknown>) =>
		mockModule.insertCommunityReport(...args),
	getCommunityReportById: (...args: Array<unknown>) =>
		mockModule.getCommunityReportById(...args),
	insertCommunityFork: (...args: Array<unknown>) =>
		mockModule.insertCommunityFork(...args),
}))

vi.mock('./snapshot.ts', () => ({
	writeCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.writeCommunitySnapshot(...args),
	readCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.readCommunitySnapshot(...args),
	deleteCommunitySnapshot: vi.fn(),
}))

const {
	publishCommunityListing,
	rateCommunityListing,
	reportCommunityListing,
	searchCommunityListings,
	forkCommunityListing,
} = await import('./service.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	} as Env
}

function sampleListing(
	overrides: Partial<CommunityListingRecord> = {},
): CommunityListingRecord {
	return {
		id: 'listing-1',
		ownerUserId: 'owner-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		kodyId: 'discord-gateway',
		name: '@owner/discord-gateway',
		description: 'Discord gateway helpers',
		tags: ['discord', 'gateway'],
		searchText: 'websocket bot',
		readmeContent: '# Discord Gateway\n\n## Intent\n\nBridge Discord events.',
		license: 'MIT',
		pinnedCommit: 'commit-1',
		status: 'active',
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T00:00:00.000Z',
		...overrides,
	}
}

test('publishCommunityListing rejects banned users', async () => {
	mockModule.getCommunityBan.mockResolvedValue({
		userId: 'user-1',
		bannedByUserId: 'admin-1',
		reason: 'spam',
		createdAt: '2026-07-01T00:00:00.000Z',
	})

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('banned from community participation')
})

test('publishCommunityListing requires MIT license and Intent heading', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@owner/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	})
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)

	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@owner/discord-gateway',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@owner/discord-gateway',
				license: 'Apache-2.0',
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'discord-gateway',
					description: 'Discord helpers',
				},
			}),
			'README.md': '# Discord Gateway\n\nNo intent here.',
		},
	})

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow(
		'community listings currently require the MIT license in package.json',
	)

	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@owner/discord-gateway',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@owner/discord-gateway',
				license: 'MIT',
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'discord-gateway',
					description: 'Discord helpers',
				},
			}),
			'README.md': '# Discord Gateway\n\nNo intent here.',
		},
	})

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('README.md to include a "## Intent" section')
})

test('rateCommunityListing requires an existing fork', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityForkByListingAndUser.mockResolvedValue(null)

	await expect(
		rateCommunityListing({
			env: createEnv(),
			userId: 'user-2',
			listingId: 'listing-1',
			stars: 5,
			adaptationEffort: 2,
		}),
	).rejects.toThrow('rate after forking')
})

test('searchCommunityListings returns the relevant listing first', async () => {
	const discordListing = sampleListing({
		id: 'listing-discord',
		kodyId: 'discord-gateway',
		name: '@owner/discord-gateway',
		description: 'Discord gateway websocket helpers',
		tags: ['discord', 'gateway'],
		searchText: 'discord bot websocket',
	})
	const weatherListing = sampleListing({
		id: 'listing-weather',
		kodyId: 'weather-widget',
		name: '@owner/weather-widget',
		description: 'Weather forecast widget',
		tags: ['weather'],
		searchText: 'forecast temperature',
		readmeContent: '# Weather\n\n## Intent\n\nShow weather.',
	})

	mockModule.listAllCommunityListings.mockResolvedValue([
		weatherListing,
		discordListing,
	])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({
		'listing-discord': {
			listingId: 'listing-discord',
			ratingCount: 10,
			averageStars: 4.8,
			averageAdaptationEffort: 2,
		},
		'listing-weather': {
			listingId: 'listing-weather',
			ratingCount: 2,
			averageStars: 3,
			averageAdaptationEffort: 3,
		},
	})
	mockModule.countCommunityForksByListingIds.mockResolvedValue({
		'listing-discord': 4,
		'listing-weather': 1,
	})

	const results = await searchCommunityListings({
		env: createEnv(),
		query: 'discord gateway websocket',
		limit: 5,
	})

	expect(results).toHaveLength(1)
	expect(results[0]?.id).toBe('listing-discord')
})

test('forkCommunityListing creates inert source without saved package row', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'commit-1',
		createdAt: '2026-07-01T00:00:00.000Z',
		files: {
			'package.json': JSON.stringify(
				{
					name: '@owner/discord-gateway',
					license: 'MIT',
					exports: { '.': './src/index.ts' },
					kody: {
						id: 'discord-gateway',
						description: 'Discord helpers',
						dependencies: ['@owner/shared-utils'],
					},
				},
				null,
				'\t',
			),
			'src/index.ts': `import { x } from 'kody:@owner/shared-utils/x'\n`,
			'README.md': '# Discord Gateway\n\n## Intent\n\nBridge events.',
		},
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'fork-source-1',
		bootstrapAccess: { token: 'bootstrap' },
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-fork-1')

	const result = await forkCommunityListing({
		env: createEnv(),
		baseUrl: 'https://heykody.dev',
		userId: 'user-2',
		expectedPackageScope: 'jane',
		listingId: 'listing-1',
		kodyId: 'my-discord-gateway',
	})

	expect(result.targetKodyId).toBe('my-discord-gateway')
	expect(result.targetName).toBe('@jane/my-discord-gateway')
	expect(result.crossScopeReferences).toEqual([
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
	])
	expect(mockModule.ensureEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-2',
			entityKind: 'package',
		}),
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.insertCommunityFork).toHaveBeenCalled()
})

test('reportCommunityListing inserts denormalized listing metadata', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityReportById.mockResolvedValue({
		id: 'report-1',
		listingId: 'listing-1',
		listingName: '@owner/discord-gateway',
		listingOwnerUserId: 'owner-1',
		reporterUserId: 'user-2',
		reason: 'spam content',
		status: 'open',
		resolvedByUserId: null,
		resolvedAt: null,
		resolutionNote: null,
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
	})

	const report = await reportCommunityListing({
		env: createEnv(),
		userId: 'user-2',
		listingId: 'listing-1',
		reason: '  spam content  ',
	})

	expect(mockModule.insertCommunityReport).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			listing_name: '@owner/discord-gateway',
			listing_owner_user_id: 'owner-1',
			reporter_user_id: 'user-2',
			reason: 'spam content',
		}),
	)
	expect(report.listingName).toBe('@owner/discord-gateway')
})
