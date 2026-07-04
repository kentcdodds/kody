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
	listCommunityForksByListingAndUser: vi.fn(),
	upsertCommunityRating: vi.fn(),
	insertCommunityReport: vi.fn(),
	getCommunityReportById: vi.fn(),
	readCommunitySnapshot: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getSavedPackageByName: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	deleteEntitySource: vi.fn(),
	cleanupArtifactReposForPackage: vi.fn(),
	insertCommunityFork: vi.fn(),
	deleteCommunityListing: vi.fn(),
	deleteCommunityRatingsByListingId: vi.fn(),
	deleteCommunitySnapshot: vi.fn(),
	setCommunityListingStatus: vi.fn(),
	resolveCommunityReportRow: vi.fn(),
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

vi.mock('#worker/repo/entity-sources.ts', () => ({
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
}))

vi.mock('#worker/repo/artifact-repo-cleanup.ts', () => ({
	cleanupArtifactReposForPackage: (...args: Array<unknown>) =>
		mockModule.cleanupArtifactReposForPackage(...args),
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
	listCommunityForksByListingAndUser: (...args: Array<unknown>) =>
		mockModule.listCommunityForksByListingAndUser(...args),
	upsertCommunityRating: (...args: Array<unknown>) =>
		mockModule.upsertCommunityRating(...args),
	insertCommunityReport: (...args: Array<unknown>) =>
		mockModule.insertCommunityReport(...args),
	getCommunityReportById: (...args: Array<unknown>) =>
		mockModule.getCommunityReportById(...args),
	insertCommunityFork: (...args: Array<unknown>) =>
		mockModule.insertCommunityFork(...args),
	deleteCommunityListing: (...args: Array<unknown>) =>
		mockModule.deleteCommunityListing(...args),
	deleteCommunityRatingsByListingId: (...args: Array<unknown>) =>
		mockModule.deleteCommunityRatingsByListingId(...args),
	resolveCommunityReportRow: (...args: Array<unknown>) =>
		mockModule.resolveCommunityReportRow(...args),
	setCommunityListingStatus: (...args: Array<unknown>) =>
		mockModule.setCommunityListingStatus(...args),
}))

vi.mock('./snapshot.ts', () => ({
	writeCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.writeCommunitySnapshot(...args),
	readCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.readCommunitySnapshot(...args),
	deleteCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.deleteCommunitySnapshot(...args),
}))

const {
	publishCommunityListing,
	unpublishCommunityListing,
	rateCommunityListing,
	reportCommunityListing,
	searchCommunityListings,
	forkCommunityListing,
	resolveCommunityReport,
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

function validPublishSource() {
	return {
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
			'README.md': '# Discord Gateway\n\n## Intent\n\nBridge Discord events.',
		},
	}
}

function validSavedPackage() {
	return {
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
	}
}

test('publishCommunityListing writes D1 before KV and reverts insert on KV failure', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(validPublishSource())
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	const callOrder: Array<string> = []
	mockModule.insertCommunityListing.mockImplementation(async () => {
		callOrder.push('insert')
	})
	mockModule.writeCommunitySnapshot.mockImplementation(async () => {
		callOrder.push('snapshot')
		throw new Error('kv down')
	})
	mockModule.deleteCommunityListing.mockResolvedValue(true)

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('kv down')

	expect(callOrder).toEqual(['insert', 'snapshot'])
	expect(mockModule.deleteCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			ownerUserId: 'user-1',
		}),
	)
})

test('publishCommunityListing rejects re-publish when guarded update finds delisted listing', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing({ status: 'active' }),
	)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(validPublishSource())
	mockModule.updateCommunityListing.mockResolvedValue(false)

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('was delisted by an admin and cannot be re-published')

	expect(mockModule.updateCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			requireStatus: 'active',
		}),
	)
	expect(mockModule.writeCommunitySnapshot).not.toHaveBeenCalled()
})

test('publishCommunityListing restores previous D1 row when KV fails on update', async () => {
	const existingListing = sampleListing()
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		existingListing,
	)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(validPublishSource())
	mockModule.getCommunityListingById.mockResolvedValue(existingListing)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	mockModule.writeCommunitySnapshot.mockRejectedValue(new Error('kv down'))

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('kv down')

	expect(mockModule.updateCommunityListing).toHaveBeenCalledTimes(2)
	expect(mockModule.updateCommunityListing).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			listingId: existingListing.id,
			pinnedCommit: existingListing.pinnedCommit,
			publishedAt: existingListing.publishedAt,
		}),
	)
})

test('unpublishCommunityListing refuses delisted listings without deleting anything', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ status: 'delisted' }),
	)

	await expect(
		unpublishCommunityListing({
			env: createEnv(),
			userId: 'owner-1',
			listingId: 'listing-1',
		}),
	).rejects.toThrow(
		'This listing was delisted by an administrator and cannot be unpublished.',
	)

	expect(mockModule.deleteCommunityListing).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunityRatingsByListingId).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunitySnapshot).not.toHaveBeenCalled()
})

test('unpublishCommunityListing deletes active listings and cascades cleanup', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.deleteCommunityListing.mockResolvedValue(true)

	await unpublishCommunityListing({
		env: createEnv(),
		userId: 'owner-1',
		listingId: 'listing-1',
	})

	expect(mockModule.deleteCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		{
			listingId: 'listing-1',
			ownerUserId: 'owner-1',
		},
	)
	expect(mockModule.deleteCommunityRatingsByListingId).toHaveBeenCalledWith(
		expect.anything(),
		'listing-1',
	)
	expect(mockModule.deleteCommunitySnapshot).toHaveBeenCalledWith(
		expect.anything(),
		'listing-1',
	)
})

test('unpublishCommunityListing skips cascade when listing delete returns false', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.deleteCommunityListing.mockResolvedValue(false)

	await expect(
		unpublishCommunityListing({
			env: createEnv(),
			userId: 'owner-1',
			listingId: 'listing-1',
		}),
	).rejects.toThrow('was not found')

	expect(mockModule.deleteCommunityRatingsByListingId).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunitySnapshot).not.toHaveBeenCalled()
})

test('resolveCommunityReport delete skips cascade when listing delete returns false', async () => {
	mockModule.getCommunityReportById.mockResolvedValue({
		id: 'report-1',
		listingId: 'listing-1',
		listingName: '@owner/discord-gateway',
		listingOwnerUserId: 'owner-1',
		reporterUserId: 'user-2',
		reason: 'spam',
		status: 'open',
		resolvedByUserId: null,
		resolvedAt: null,
		resolutionNote: null,
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
	})
	mockModule.deleteCommunityListing.mockResolvedValue(false)
	mockModule.resolveCommunityReportRow.mockResolvedValue(true)

	await resolveCommunityReport({
		env: createEnv(),
		adminUserId: 'admin-1',
		reportId: 'report-1',
		action: 'delete',
	})

	expect(mockModule.deleteCommunityRatingsByListingId).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunitySnapshot).not.toHaveBeenCalled()
	expect(mockModule.resolveCommunityReportRow).toHaveBeenCalled()
})

test('forkCommunityListing rejects banned users', async () => {
	mockModule.getCommunityBan.mockResolvedValue({
		userId: 'user-2',
		bannedByUserId: 'admin-1',
		reason: 'spam',
		createdAt: '2026-07-01T00:00:00.000Z',
	})

	await expect(
		forkCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-2',
			expectedPackageScope: 'jane',
			listingId: 'listing-1',
		}),
	).rejects.toThrow('banned from community participation')
})

test('searchCommunityListings returns empty when limit is 0', async () => {
	const listing = sampleListing()
	mockModule.listAllCommunityListings.mockResolvedValue([listing])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({
		'listing-1': {
			listingId: 'listing-1',
			ratingCount: 1,
			averageStars: 4,
			averageAdaptationEffort: 2,
		},
	})
	mockModule.countCommunityForksByListingIds.mockResolvedValue({
		'listing-1': 0,
	})

	const emptyQueryResults = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 0,
	})
	const queryResults = await searchCommunityListings({
		env: createEnv(),
		query: 'discord',
		limit: 0,
	})

	expect(emptyQueryResults).toEqual([])
	expect(queryResults).toEqual([])
})

test('searchCommunityListings empty query uses publishedAt tiebreaker', async () => {
	const olderListing = sampleListing({
		id: 'listing-older',
		publishedAt: '2026-07-01T00:00:00.000Z',
	})
	const newerListing = sampleListing({
		id: 'listing-newer',
		publishedAt: '2026-07-03T00:00:00.000Z',
	})
	mockModule.listAllCommunityListings.mockResolvedValue([
		olderListing,
		newerListing,
	])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({
		'listing-older': {
			listingId: 'listing-older',
			ratingCount: 0,
			averageStars: null,
			averageAdaptationEffort: null,
		},
		'listing-newer': {
			listingId: 'listing-newer',
			ratingCount: 0,
			averageStars: null,
			averageAdaptationEffort: null,
		},
	})
	mockModule.countCommunityForksByListingIds.mockResolvedValue({
		'listing-older': 0,
		'listing-newer': 0,
	})

	const results = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
	})

	expect(results.map((listing) => listing.id)).toEqual([
		'listing-newer',
		'listing-older',
	])
})

test('publishCommunityListing accepts Intent heading beyond storage truncation', async () => {
	const padding = 'x'.repeat(20_000)
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...validPublishSource(),
		files: {
			...validPublishSource().files,
			'README.md': `${padding}\n\n## Intent\n\nBridge Discord events.`,
		},
	})
	mockModule.insertCommunityListing.mockResolvedValue(undefined)
	mockModule.writeCommunitySnapshot.mockResolvedValue(undefined)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())

	await publishCommunityListing({
		env: createEnv(),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
	})

	expect(mockModule.insertCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			readme_content: expect.stringMatching(/…$/),
		}),
	)
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

test('rateCommunityListing rejects ratings from the listing owner', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityForkByListingAndUser.mockResolvedValue({
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'owner-1',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway',
		createdAt: '2026-07-01T00:00:00.000Z',
	})

	await expect(
		rateCommunityListing({
			env: createEnv(),
			userId: 'owner-1',
			listingId: 'listing-1',
			stars: 5,
			adaptationEffort: 2,
		}),
	).rejects.toThrow('You cannot rate your own listing.')

	expect(mockModule.upsertCommunityRating).not.toHaveBeenCalled()
})

test('rateCommunityListing allows non-owners with a fork row', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityForkByListingAndUser.mockResolvedValue({
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-2',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway',
		createdAt: '2026-07-01T00:00:00.000Z',
	})

	await rateCommunityListing({
		env: createEnv(),
		userId: 'user-2',
		listingId: 'listing-1',
		stars: 5,
		adaptationEffort: 2,
	})

	expect(mockModule.upsertCommunityRating).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			listing_id: 'listing-1',
			user_id: 'user-2',
			stars: 5,
			adaptation_effort: 2,
		}),
	)
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
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([])
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
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			target_kody_id: 'my-discord-gateway',
		}),
	)
})

test('forkCommunityListing rejects repeat fork without a new kody_id', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'commit-1',
		createdAt: '2026-07-01T00:00:00.000Z',
		files: validPublishSource().files,
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([
		{
			id: 'fork-1',
			listingId: 'listing-1',
			forkerUserId: 'user-2',
			originCommit: 'commit-1',
			forkedPackageId: 'package-fork-1',
			forkedSourceId: 'fork-source-1',
			targetKodyId: 'discord-gateway',
			createdAt: '2026-07-01T00:00:00.000Z',
		},
	])

	await expect(
		forkCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-2',
			expectedPackageScope: 'jane',
			listingId: 'listing-1',
		}),
	).rejects.toThrow(
		'Resume the existing fork with source_id "fork-source-1" (package_id "package-fork-1")',
	)

	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
})

test('forkCommunityListing allows repeat fork with a different kody_id', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'commit-1',
		createdAt: '2026-07-01T00:00:00.000Z',
		files: validPublishSource().files,
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([
		{
			id: 'fork-1',
			listingId: 'listing-1',
			forkerUserId: 'user-2',
			originCommit: 'commit-1',
			forkedPackageId: 'package-fork-1',
			forkedSourceId: 'fork-source-1',
			targetKodyId: 'discord-gateway',
			createdAt: '2026-07-01T00:00:00.000Z',
		},
	])
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'fork-source-2',
		bootstrapAccess: { token: 'bootstrap' },
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-fork-2')

	const result = await forkCommunityListing({
		env: createEnv(),
		baseUrl: 'https://heykody.dev',
		userId: 'user-2',
		expectedPackageScope: 'jane',
		listingId: 'listing-1',
		kodyId: 'my-second-fork',
	})

	expect(result.targetKodyId).toBe('my-second-fork')
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			target_kody_id: 'my-second-fork',
		}),
	)
})

test('forkCommunityListing cleans up entity source when snapshot sync fails', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'commit-1',
		createdAt: '2026-07-01T00:00:00.000Z',
		files: validPublishSource().files,
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([])
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'fork-source-1',
		bootstrapAccess: { token: 'bootstrap' },
	})
	mockModule.syncArtifactSourceSnapshot.mockRejectedValue(
		new Error('sync failed'),
	)
	mockModule.cleanupArtifactReposForPackage.mockResolvedValue(0)
	mockModule.deleteEntitySource.mockResolvedValue(true)

	await expect(
		forkCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-2',
			expectedPackageScope: 'jane',
			listingId: 'listing-1',
			kodyId: 'my-discord-gateway',
		}),
	).rejects.toThrow('sync failed')

	expect(mockModule.cleanupArtifactReposForPackage).toHaveBeenCalledWith({
		env: createEnv(),
		userId: 'user-2',
		sourceId: 'fork-source-1',
	})
	expect(mockModule.deleteEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		{
			id: 'fork-source-1',
			userId: 'user-2',
		},
	)
	expect(mockModule.insertCommunityFork).not.toHaveBeenCalled()
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
