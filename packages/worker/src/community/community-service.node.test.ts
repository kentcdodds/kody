import { expect, test, vi } from 'vitest'
import type * as CommunityRepo from './repo.ts'
import { type CommunityListingRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	getCommunityBan: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	getCommunityListingById: vi.fn(),
	listCommunityListingCandidates: vi.fn(),
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
		'community listings require the MIT license in package.json',
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

test('rateCommunityListing requires a fork and rejects owner self-ratings', async () => {
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
