import { expect, test, vi } from 'vitest'
import { CommunityActionError } from './errors.ts'
import type * as CommunityRepo from './repo.ts'
import { type CommunityListingRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	enqueueCommunityActivityDispatch: vi.fn(),
	getSavedPackageById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	getCommunityBan: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	getCommunityListingById: vi.fn(),
	listCommunityListingCandidates: vi.fn(),
	getCommunityRatingAggregatesByListingIds: vi.fn(),
	countCommunityForksByListingIds: vi.fn(),
	countCommunityStarsByListingIds: vi.fn(),
	insertCommunityActivityEvent: vi.fn(),
	deleteCommunityActivityEventsByListingId: vi.fn(),
	deleteCommunityStarsByListingId: vi.fn(),
	writeCommunitySnapshot: vi.fn(),
	insertCommunityListing: vi.fn(),
	updateCommunityListing: vi.fn(),
	getCommunityForkByListingAndUser: vi.fn(),
	getCommunityForkByForkedPackageId: vi.fn(),
	listCommunityForksByListingAndUser: vi.fn(),
	markCommunityForkAdopted: vi.fn(),
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

vi.mock('./activity-dispatch-queue-producer.ts', () => ({
	enqueueCommunityActivityDispatch: (...args: Array<unknown>) =>
		mockModule.enqueueCommunityActivityDispatch(...args),
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

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityRepo>()
	return {
		// Pure helper used by the service to decide whether the SQL LIKE
		// pre-filter was applied; keep the real implementation.
		extractCommunityListingLikeTokens: actual.extractCommunityListingLikeTokens,
		getCommunityBan: (...args: Array<unknown>) =>
			mockModule.getCommunityBan(...args),
		getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
			mockModule.getCommunityListingByOwnerAndPackage(...args),
		getCommunityListingById: (...args: Array<unknown>) =>
			mockModule.getCommunityListingById(...args),
		listCommunityListingCandidates: (...args: Array<unknown>) =>
			mockModule.listCommunityListingCandidates(...args),
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
		getCommunityForkByForkedPackageId: (...args: Array<unknown>) =>
			mockModule.getCommunityForkByForkedPackageId(...args),
		listCommunityForksByListingAndUser: (...args: Array<unknown>) =>
			mockModule.listCommunityForksByListingAndUser(...args),
		markCommunityForkAdopted: (...args: Array<unknown>) =>
			mockModule.markCommunityForkAdopted(...args),
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
	}
})

vi.mock('./snapshot.ts', () => ({
	writeCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.writeCommunitySnapshot(...args),
	readCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.readCommunitySnapshot(...args),
	deleteCommunitySnapshot: (...args: Array<unknown>) =>
		mockModule.deleteCommunitySnapshot(...args),
}))

vi.mock('./social-repo.ts', () => ({
	countCommunityStarsByListingIds: (...args: Array<unknown>) =>
		mockModule.countCommunityStarsByListingIds(...args),
	insertCommunityActivityEvent: (...args: Array<unknown>) =>
		mockModule.insertCommunityActivityEvent(...args),
	deleteCommunityActivityEventsByListingId: (...args: Array<unknown>) =>
		mockModule.deleteCommunityActivityEventsByListingId(...args),
	deleteCommunityStarsByListingId: (...args: Array<unknown>) =>
		mockModule.deleteCommunityStarsByListingId(...args),
}))

const {
	publishCommunityListing,
	unpublishCommunityListing,
	rateCommunityListing,
	reportCommunityListing,
	searchCommunityListings,
	forkCommunityListing,
	adoptCommunityFork,
} = await import('./service.ts')

const testBundleArtifactsKv = {
	delete: vi.fn(async () => undefined),
	list: vi.fn(async () => ({
		keys: [{ name: 'derived-cache:v1:community-icon:v1:listing-1:commit-1' }],
		list_complete: true,
	})),
} as unknown as KVNamespace
const testCommunityAssets = {
	delete: vi.fn(async () => undefined),
	list: vi.fn(async () => ({
		objects: [
			{ key: 'community-icon:v1/listing-1/commit-1/asset' },
			{ key: 'community-icon:v1/listing-1/commit-2/asset' },
		],
		truncated: false,
	})),
} as unknown as R2Bucket
const testCommunityActivityQueue = {
	send: vi.fn(),
} as unknown as Queue

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: testBundleArtifactsKv,
		COMMUNITY_ASSETS: testCommunityAssets,
		COMMUNITY_ACTIVITY_DISPATCH_QUEUE: testCommunityActivityQueue,
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
		iconCommit: 'commit-1',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T00:00:00.000Z',
		...overrides,
	}
}

test('community operations reject banned users', async () => {
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
	).rejects.toThrow(/banned from community participation/)

	await expect(
		forkCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-2',
			expectedPackageScope: 'jane',
			listingId: 'listing-1',
		}),
	).rejects.toThrow(/banned from community participation/)

	// Delegated publishes bind bans to the acting person too: the platform
	// owner is not banned, but the banned actor must still be rejected.
	mockModule.getCommunityBan.mockImplementation(
		async (_db: unknown, userId: unknown) =>
			userId === 'user-1'
				? {
						userId: 'user-1',
						bannedByUserId: 'admin-1',
						reason: 'spam',
						createdAt: '2026-07-01T00:00:00.000Z',
					}
				: null,
	)
	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'platform-owner-1',
			actorUserId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow(/banned from community participation/)

	await expect(
		unpublishCommunityListing({
			env: createEnv(),
			userId: 'platform-owner-1',
			actorUserId: 'user-1',
			listingId: 'listing-1',
		}),
	).rejects.toThrow(/banned from community participation/)
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
		hidden: false,
		isPrivate: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	}
}

test('publishCommunityListing rolls back D1 when KV snapshot write fails', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(validPublishSource())
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())

	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	mockModule.insertCommunityListing.mockImplementation(async () => undefined)
	mockModule.writeCommunitySnapshot.mockRejectedValue(new Error('kv down'))
	mockModule.deleteCommunityListing.mockResolvedValue(true)

	const insertCallOrder: Array<string> = []
	mockModule.insertCommunityListing.mockImplementation(async () => {
		insertCallOrder.push('insert')
	})
	mockModule.writeCommunitySnapshot.mockImplementation(async () => {
		insertCallOrder.push('snapshot')
		throw new Error('kv down')
	})

	await expect(
		publishCommunityListing({
			env: createEnv(),
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('kv down')

	expect(insertCallOrder).toEqual(['insert', 'snapshot'])
	expect(mockModule.deleteCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			ownerUserId: 'user-1',
		}),
	)

	const existingListing = sampleListing()
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		existingListing,
	)
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
	).rejects.toThrow()

	expect(mockModule.deleteCommunityListing).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunityRatingsByListingId).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunitySnapshot).not.toHaveBeenCalled()
})

test('unpublishCommunityListing deletes active listings and cascades cleanup', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.deleteCommunityListing.mockResolvedValue(true)
	testCommunityAssets.delete.mockRejectedValue(new Error('r2 unavailable'))
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

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
	expect(
		mockModule.deleteCommunityActivityEventsByListingId,
	).toHaveBeenCalledWith(expect.anything(), 'listing-1')
	expect(mockModule.deleteCommunityStarsByListingId).toHaveBeenCalledWith(
		expect.anything(),
		'listing-1',
	)
	expect(mockModule.deleteCommunitySnapshot).toHaveBeenCalledWith(
		expect.anything(),
		'listing-1',
	)
	expect(
		mockModule.deleteCommunityListing.mock.invocationCallOrder[0],
	).toBeLessThan(testCommunityAssets.delete.mock.invocationCallOrder[0] ?? 0)
	expect(consoleError).toHaveBeenCalledWith(
		'community-icon-delete-failed',
		'unpublish',
		'listing-1',
		expect.any(Error),
	)
	consoleError.mockRestore()
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
	mockModule.listCommunityListingCandidates.mockResolvedValue([
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
	mockModule.countCommunityStarsByListingIds.mockResolvedValue({
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

test('searchCommunityListings falls back to unfiltered candidates when LIKE prefilter rows all fail matching', async () => {
	// The LIKE prefilter matches on raw columns (e.g. readme_content), so it
	// can return rows that the in-memory scorer then rejects. The fallback
	// must still surface matches among other recent listings.
	const prefilterOnlyListing = sampleListing({
		id: 'listing-prefilter-only',
		kodyId: 'meal-planner',
		name: '@owner/meal-planner',
		description: 'Plan weekly meals',
		tags: ['meal'],
		searchText: 'meal plan grocery',
		readmeContent: '# Meal Planner\n\n## Intent\n\nPlan meals.',
	})
	const fallbackMatchListing = sampleListing({ id: 'listing-fallback-match' })
	mockModule.listCommunityListingCandidates
		.mockResolvedValueOnce([prefilterOnlyListing])
		.mockResolvedValueOnce([prefilterOnlyListing, fallbackMatchListing])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({
		'listing-fallback-match': {
			listingId: 'listing-fallback-match',
			ratingCount: 0,
			averageStars: null,
			averageAdaptationEffort: null,
		},
	})
	mockModule.countCommunityForksByListingIds.mockResolvedValue({
		'listing-fallback-match': 0,
	})
	mockModule.countCommunityStarsByListingIds.mockResolvedValue({
		'listing-fallback-match': 0,
	})

	const results = await searchCommunityListings({
		env: createEnv(),
		query: 'discord',
		limit: 10,
	})

	expect(results.map((listing) => listing.id)).toEqual([
		'listing-fallback-match',
	])
	expect(mockModule.listCommunityListingCandidates).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		expect.objectContaining({ query: 'discord' }),
	)
	expect(mockModule.listCommunityListingCandidates).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		expect.not.objectContaining({ query: expect.anything() }),
	)
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
			'community-icon.png': 'binary bytes decoded as text',
			'community-icon.jpg': 'extra binary bytes decoded as text',
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
	expect(mockModule.writeCommunitySnapshot).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			communityIconPath: 'community-icon.png',
			files: expect.not.objectContaining({
				'community-icon.png': expect.anything(),
				'community-icon.jpg': expect.anything(),
			}),
		}),
	)
})

test('publishCommunityListing invalidates old and reused icon revisions', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing(),
	)
	const republishedSource = validPublishSource()
	republishedSource.source.published_commit = 'commit-2'
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(republishedSource)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	mockModule.writeCommunitySnapshot.mockResolvedValue(undefined)
	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ pinnedCommit: 'commit-2' }),
	)

	await publishCommunityListing({
		env: createEnv(),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
	})

	expect(testCommunityAssets.delete).toHaveBeenCalledWith(
		'community-icon:v1/listing-1/commit-1/asset',
	)
	expect(testCommunityAssets.delete).toHaveBeenCalledWith(
		'community-icon:v1/listing-1/commit-2/asset',
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
		hidden: false,
		isPrivate: false,
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
	).rejects.toThrow(/MIT license/)

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
	).rejects.toThrow(/Intent/)
})

test('publishCommunityListing rejects private packages', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
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
				private: true,
				license: 'MIT',
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'discord-gateway',
					description: 'Discord helpers',
				},
			}),
			'README.md': '# Discord Gateway\n\n## Intent\n\nBridge Discord events.',
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
		'community listings cannot publish packages with `"private": true`',
	)
})

test('rateCommunityListing rejects owner self-ratings and persists valid ratings', async () => {
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
		adoptedAt: null,
		adoptionNote: null,
	})
	mockModule.upsertCommunityRating.mockResolvedValue({
		id: 'rating-1',
		listingId: 'listing-1',
		userId: 'user-2',
		stars: 5,
		adaptationEffort: 2,
		note: null,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	})

	await expect(
		rateCommunityListing({
			env: createEnv(),
			userId: 'owner-1',
			listingId: 'listing-1',
			stars: 5,
			adaptationEffort: 2,
		}),
	).rejects.toBeInstanceOf(CommunityActionError)
	expect(mockModule.upsertCommunityRating).not.toHaveBeenCalled()

	mockModule.getCommunityForkByListingAndUser.mockResolvedValue({
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-2',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway',
		createdAt: '2026-07-01T00:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
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
	expect(mockModule.enqueueCommunityActivityDispatch).toHaveBeenCalledWith({
		queue: expect.anything(),
		kind: 'rating',
		activityId: 'rating-1',
	})
})

test('rateCommunityListing rejects ratings without a prior fork as CommunityActionError', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityForkByListingAndUser.mockResolvedValue(null)

	await expect(
		rateCommunityListing({
			env: createEnv(),
			userId: 'user-2',
			listingId: 'listing-1',
			stars: 4,
			adaptationEffort: 2,
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof CommunityActionError &&
			error.message === 'Fork this community listing before rating it.',
	)
	expect(mockModule.upsertCommunityRating).not.toHaveBeenCalled()
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
			listing_name: '@owner/discord-gateway',
			listing_kody_id: 'discord-gateway',
		}),
	)
	expect(mockModule.enqueueCommunityActivityDispatch).toHaveBeenCalledWith({
		queue: expect.anything(),
		kind: 'fork',
		activityId: expect.any(String),
	})
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
			adoptedAt: null,
			adoptionNote: null,
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
	).rejects.toThrow()

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
			adoptedAt: null,
			adoptionNote: null,
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

test('adoptCommunityFork marks a fork adopted with review note', async () => {
	mockModule.getSavedPackageById.mockResolvedValue({
		...validSavedPackage(),
		id: 'package-fork-1',
		userId: 'user-2',
		kodyId: 'discord-gateway-fork',
		name: '@jane/discord-gateway-fork',
	})
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue({
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-2',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway-fork',
		createdAt: '2026-07-01T00:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
	})
	mockModule.markCommunityForkAdopted.mockResolvedValue({
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-2',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway-fork',
		createdAt: '2026-07-01T00:00:00.000Z',
		adoptedAt: '2026-07-21T00:00:00.000Z',
		adoptionNote: 'Reviewed gateway auth and host allowlists.',
	})

	const result = await adoptCommunityFork({
		env: createEnv(),
		userId: 'user-2',
		packageId: 'package-fork-1',
		reviewSummary: 'Reviewed gateway auth and host allowlists.',
	})

	expect(result).toMatchObject({
		packageId: 'package-fork-1',
		kodyId: 'discord-gateway-fork',
		listingId: 'listing-1',
		originCommit: 'commit-1',
		alreadyAdopted: false,
	})
	expect(mockModule.markCommunityForkAdopted).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			forkerUserId: 'user-2',
			forkedPackageId: 'package-fork-1',
			adoptionNote: 'Reviewed gateway auth and host allowlists.',
		}),
	)
})

test('adoptCommunityFork rejects self-authored packages and short review summaries', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)

	await expect(
		adoptCommunityFork({
			env: createEnv(),
			userId: 'user-1',
			packageId: 'package-1',
			reviewSummary: 'Looks fine',
		}),
	).rejects.toThrow(/already self-authored/)

	await expect(
		adoptCommunityFork({
			env: createEnv(),
			userId: 'user-1',
			packageId: 'package-1',
			reviewSummary: 'short',
		}),
	).rejects.toThrow(/review_summary/)
})

test('adoptCommunityFork is idempotent when already adopted and isolates by user', async () => {
	mockModule.getSavedPackageById.mockResolvedValue({
		...validSavedPackage(),
		id: 'package-fork-1',
		userId: 'user-2',
		kodyId: 'discord-gateway-fork',
	})
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue({
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-2',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway-fork',
		createdAt: '2026-07-01T00:00:00.000Z',
		adoptedAt: '2026-07-10T00:00:00.000Z',
		adoptionNote: 'Earlier review.',
	})

	const result = await adoptCommunityFork({
		env: createEnv(),
		userId: 'user-2',
		packageId: 'package-fork-1',
		reviewSummary: 'Reviewed again after more edits.',
	})
	expect(result.alreadyAdopted).toBe(true)
	expect(result.adoptedAt).toBe('2026-07-10T00:00:00.000Z')
	expect(mockModule.markCommunityForkAdopted).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	await expect(
		adoptCommunityFork({
			env: createEnv(),
			userId: 'user-b',
			packageId: 'package-fork-1',
			reviewSummary: 'Trying to adopt someone else fork.',
		}),
	).rejects.toThrow(/was not found/)
	expect(mockModule.markCommunityForkAdopted).not.toHaveBeenCalled()
})
