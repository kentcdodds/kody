import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import {
	blendLexicalAndVectorScore,
	cosineSimilarity,
	deterministicEmbedding,
	lexicalScore,
} from '#mcp/capabilities/capability-search.ts'
import { buildPackageReadmeDetail } from '#worker/package-registry/package-readme.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
	getSavedPackageByName,
} from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { cleanupArtifactReposForPackage } from '#worker/repo/artifact-repo-cleanup.ts'
import { deleteEntitySource } from '#worker/repo/entity-sources.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { assertPackageNotPrivateForCommunityPublish } from '#worker/package-registry/package-private.ts'
import { CommunityActionError } from './errors.ts'
import {
	countCommunityForksByListingIds,
	deleteCommunityListing,
	deleteCommunityRatingsByListingId,
	getCommunityBan,
	getCommunityForkByListingAndUser,
	getCommunityListingById,
	getCommunityListingByOwnerAndPackage,
	listCommunityForksByListingAndUser,
	getCommunityRatingAggregatesByListingId,
	getCommunityRatingAggregatesByListingIds,
	getCommunityReportById,
	insertCommunityFork,
	insertCommunityListing,
	insertCommunityBan,
	insertCommunityReport,
	extractCommunityListingLikeTokens,
	listCommunityListingCandidates,
	listCommunityReports as listCommunityReportsFromDb,
	resolveCommunityReportRow,
	setCommunityListingStatus,
	updateCommunityListing,
	upsertCommunityRating,
	deleteCommunityBan,
} from './repo.ts'
import {
	rewritePackageManifestForFork,
	scanCrossScopeReferences,
} from './fork-scan.ts'
import {
	deleteCommunitySnapshot,
	readCommunitySnapshot,
	writeCommunitySnapshot,
} from './snapshot.ts'
import {
	type CommunityListingRecord,
	type CommunityListingWithAggregates,
	type CommunityReportRecord,
	type CommunityReportResolutionAction,
	type ForkCommunityListingResult,
} from './types.ts'

const communityReadmeMaxChars = 20_000
const communityBayesianPriorMean = 3.25
const communityBayesianPriorWeight = 5
const intentHeadingPattern = /^##\s+intent\b/im

// Offline deterministic embeddings produce small positive cosine scores for
// unrelated text (~0.10). Related lexical hits use lexical > 0; vector-only
// semantic matches on listing documents tend to land above ~0.12.
export const COMMUNITY_SEARCH_VECTOR_MATCH_THRESHOLD = 0.12

// Community search/browse never scores more than this many listings in
// memory; candidates are pre-filtered and recency-ordered in SQL. This is
// a deliberate bound: browse ranks within the newest candidates, so
// listings older than the newest 500 are reachable through search (LIKE
// pre-filter) but not through unfiltered browse pagination. Revisit with
// a materialized score column if the catalog ever approaches this size.
export const COMMUNITY_SEARCH_CANDIDATE_LIMIT = 500

export function isCommunityListingSearchMatch(input: {
	query: string
	document: string
}): boolean {
	const trimmedQuery = input.query.trim()
	if (!trimmedQuery) return true
	const lexical = lexicalScore(trimmedQuery, input.document)
	if (lexical > 0) return true
	const vector = cosineSimilarity(
		deterministicEmbedding(trimmedQuery),
		deterministicEmbedding(input.document),
	)
	return vector > COMMUNITY_SEARCH_VECTOR_MATCH_THRESHOLD
}

export function buildCommunityListingSearchDocument(
	listing: CommunityListingRecord,
) {
	const readmeSnippet = listing.readmeContent
		? listing.readmeContent.slice(0, 1_000)
		: ''
	return [
		listing.name,
		listing.kodyId,
		listing.description,
		listing.tags.join(' '),
		listing.searchText ?? '',
		readmeSnippet,
	]
		.filter((value) => value.length > 0)
		.join('\n')
}

export function computeCommunityBayesianScore(input: {
	averageStars: number | null
	ratingCount: number
}): number {
	const averageStars = input.averageStars ?? communityBayesianPriorMean
	return (
		(communityBayesianPriorWeight * communityBayesianPriorMean +
			input.ratingCount * averageStars) /
		(communityBayesianPriorWeight + input.ratingCount)
	)
}

export function compareCommunityListingsByBayesianAndPublishedAt(
	left: CommunityListingWithAggregates,
	right: CommunityListingWithAggregates,
): number {
	const leftScore = computeCommunityBayesianScore({
		averageStars: left.averageStars,
		ratingCount: left.ratingCount,
	})
	const rightScore = computeCommunityBayesianScore({
		averageStars: right.averageStars,
		ratingCount: right.ratingCount,
	})
	if (rightScore !== leftScore) return rightScore - leftScore
	return right.publishedAt.localeCompare(left.publishedAt)
}

function buildRepeatForkErrorMessage(input: {
	targetKodyId: string
	forkedSourceId: string
	forkedPackageId: string
}) {
	return `You already forked this listing with kody id "${input.targetKodyId}". Resume the existing fork with source_id "${input.forkedSourceId}" (package_id "${input.forkedPackageId}") via repo_open_session, or pass a different kody_id to fork again.`
}

async function cleanupFailedCommunityFork(input: {
	env: Env
	userId: string
	sourceId: string
	packageId: string
}) {
	await cleanupArtifactReposForPackage({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'community fork artifact repo cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
				error: getErrorMessage(error),
			}),
		)
	})
	await deleteEntitySource(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'community fork entity source cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
				error: getErrorMessage(error),
			}),
		)
	})
}

async function assertNotCommunityBanned(db: D1Database, userId: string) {
	const ban = await getCommunityBan(db, userId)
	if (ban) {
		throw new CommunityActionError('banned from community participation')
	}
}

function parseRawPackageLicense(packageJsonContent: string) {
	let parsed: unknown
	try {
		parsed = JSON.parse(packageJsonContent)
	} catch {
		throw new Error('Saved package package.json must be valid JSON.')
	}
	if (typeof parsed !== 'object' || parsed == null || !('license' in parsed)) {
		throw new Error(
			'community listings require the MIT license in package.json',
		)
	}
	const license = (parsed as { license?: unknown }).license
	if (typeof license !== 'string' || license.trim() !== 'MIT') {
		throw new Error(
			'community listings require the MIT license in package.json',
		)
	}
	return license.trim()
}

function assertReadmeIntent(readmeContent: string) {
	if (!intentHeadingPattern.test(readmeContent)) {
		throw new Error(
			'Community listings require README.md to include a "## Intent" section.',
		)
	}
}

function buildListingSearchDocument(listing: CommunityListingRecord) {
	return buildCommunityListingSearchDocument(listing)
}

async function attachListingAggregates(
	db: D1Database,
	listing: CommunityListingRecord,
): Promise<CommunityListingWithAggregates> {
	const [ratingAggregate, forkCounts] = await Promise.all([
		getCommunityRatingAggregatesByListingId(db, listing.id),
		countCommunityForksByListingIds(db, [listing.id]),
	])
	return {
		...listing,
		averageStars: ratingAggregate.averageStars,
		ratingCount: ratingAggregate.ratingCount,
		averageAdaptationEffort: ratingAggregate.averageAdaptationEffort,
		forkCount: forkCounts[listing.id] ?? 0,
	}
}

async function attachListingAggregatesBatch(
	db: D1Database,
	listings: Array<CommunityListingRecord>,
): Promise<Array<CommunityListingWithAggregates>> {
	if (listings.length === 0) return []
	const listingIds = listings.map((listing) => listing.id)
	const [ratingAggregates, forkCounts] = await Promise.all([
		getCommunityRatingAggregatesByListingIds(db, listingIds),
		countCommunityForksByListingIds(db, listingIds),
	])
	return listings.map((listing) => {
		const ratingAggregate = ratingAggregates[listing.id] ?? {
			listingId: listing.id,
			ratingCount: 0,
			averageStars: null,
			averageAdaptationEffort: null,
		}
		return {
			...listing,
			averageStars: ratingAggregate.averageStars,
			ratingCount: ratingAggregate.ratingCount,
			averageAdaptationEffort: ratingAggregate.averageAdaptationEffort,
			forkCount: forkCounts[listing.id] ?? 0,
		}
	})
}

export async function publishCommunityListing(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId: string
}): Promise<CommunityListingRecord> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new Error(`Saved package "${input.packageId}" was not found.`)
	}

	const loadedSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: savedPackage.sourceId,
	})
	const publishedCommit = loadedSource.source.published_commit
	if (!publishedCommit) {
		throw new Error(
			`Saved package "${input.packageId}" does not have a published commit.`,
		)
	}

	const packageJsonContent = loadedSource.files['package.json']
	if (!packageJsonContent) {
		throw new Error('Saved packages require a root package.json file.')
	}
	const license = parseRawPackageLicense(packageJsonContent)
	assertPackageNotPrivateForCommunityPublish(packageJsonContent)

	const readme = buildPackageReadmeDetail({
		files: loadedSource.files,
		maxChars: communityReadmeMaxChars,
	})
	if (!readme) {
		throw new Error('Community listings require a root README file.')
	}
	const fullReadme = buildPackageReadmeDetail({
		files: loadedSource.files,
		maxChars: Number.MAX_SAFE_INTEGER,
	})
	if (!fullReadme) {
		throw new Error('Community listings require a root README file.')
	}
	assertReadmeIntent(fullReadme.content)

	const existingListing = await getCommunityListingByOwnerAndPackage(
		input.env.APP_DB,
		{
			ownerUserId: input.userId,
			packageId: input.packageId,
		},
	)
	if (existingListing?.status === 'delisted') {
		throw new CommunityActionError(
			`Community listing for package "${input.packageId}" was delisted by an admin and cannot be re-published.`,
		)
	}

	const now = new Date().toISOString()
	const listingId = existingListing?.id ?? crypto.randomUUID()
	const tagsJson = JSON.stringify(savedPackage.tags)
	const snapshot = {
		version: 1 as const,
		listingId,
		pinnedCommit: publishedCommit,
		files: loadedSource.files,
		createdAt: now,
	}

	if (existingListing) {
		const updated = await updateCommunityListing(input.env.APP_DB, {
			listingId,
			ownerUserId: input.userId,
			sourceId: savedPackage.sourceId,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
			description: savedPackage.description,
			tagsJson,
			searchText: savedPackage.searchText,
			readmeContent: readme.content,
			license,
			pinnedCommit: publishedCommit,
			publishedAt: now,
			requireStatus: 'active',
		})
		if (!updated) {
			throw new CommunityActionError(
				`Community listing for package "${input.packageId}" was delisted by an admin and cannot be re-published.`,
			)
		}
	} else {
		await insertCommunityListing(input.env.APP_DB, {
			id: listingId,
			owner_user_id: input.userId,
			package_id: input.packageId,
			source_id: savedPackage.sourceId,
			kody_id: savedPackage.kodyId,
			name: savedPackage.name,
			description: savedPackage.description,
			tags_json: tagsJson,
			search_text: savedPackage.searchText,
			readme_content: readme.content,
			license,
			pinned_commit: publishedCommit,
			status: 'active',
			published_at: now,
		})
	}

	try {
		await writeCommunitySnapshot(input.env.BUNDLE_ARTIFACTS_KV, snapshot)
	} catch (snapshotError) {
		try {
			if (existingListing) {
				await updateCommunityListing(input.env.APP_DB, {
					listingId,
					ownerUserId: input.userId,
					sourceId: existingListing.sourceId,
					kodyId: existingListing.kodyId,
					name: existingListing.name,
					description: existingListing.description,
					tagsJson: JSON.stringify(existingListing.tags),
					searchText: existingListing.searchText,
					readmeContent: existingListing.readmeContent,
					license: existingListing.license,
					pinnedCommit: existingListing.pinnedCommit,
					publishedAt: existingListing.publishedAt,
				})
			} else {
				await deleteCommunityListing(input.env.APP_DB, {
					listingId,
					ownerUserId: input.userId,
				})
			}
		} catch (revertError) {
			console.error(
				'Failed to revert community listing after snapshot failure:',
				revertError,
			)
		}
		throw snapshotError
	}

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId,
		includeDelisted: true,
	})
	if (!listing) {
		throw new Error(`Community listing "${listingId}" could not be loaded.`)
	}
	invalidateCommunityPublicCache()
	return listing
}

export async function unpublishCommunityListing(input: {
	env: Env
	userId: string
	listingId: string
}): Promise<void> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: true,
	})
	if (!listing || listing.ownerUserId !== input.userId) {
		throw new Error(`Community listing "${input.listingId}" was not found.`)
	}
	if (listing.status === 'delisted') {
		throw new CommunityActionError(
			'This listing was delisted by an administrator and cannot be unpublished.',
		)
	}

	const deleted = await deleteCommunityListing(input.env.APP_DB, {
		listingId: input.listingId,
		ownerUserId: input.userId,
	})
	if (!deleted) {
		throw new Error(`Community listing "${input.listingId}" was not found.`)
	}

	await deleteCommunityRatingsByListingId(input.env.APP_DB, input.listingId)
	await deleteCommunitySnapshot(input.env.BUNDLE_ARTIFACTS_KV, input.listingId)
	invalidateCommunityPublicCache()
}

export async function getCommunityListingWithAggregates(input: {
	env: Env
	listingId: string
	includeDelisted: boolean
}): Promise<CommunityListingWithAggregates | null> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: input.includeDelisted,
	})
	if (!listing) return null
	return await attachListingAggregates(input.env.APP_DB, listing)
}

export async function listCommunityListingsWithAggregates(input: {
	env: Env
	includeDelisted: boolean
	limit: number
	offset: number
}): Promise<Array<CommunityListingWithAggregates>> {
	const listings = await listCommunityListingCandidates(input.env.APP_DB, {
		includeDelisted: input.includeDelisted,
		limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
	})
	const withAggregates = await attachListingAggregatesBatch(
		input.env.APP_DB,
		listings,
	)
	return withAggregates
		.sort(compareCommunityListingsByBayesianAndPublishedAt)
		.slice(input.offset, input.offset + input.limit)
}

export async function searchCommunityListings(input: {
	env: Env
	query: string
	limit: number
}): Promise<Array<CommunityListingWithAggregates>> {
	const trimmedQuery = input.query.trim()
	let listings = await listCommunityListingCandidates(input.env.APP_DB, {
		includeDelisted: false,
		limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
		query: trimmedQuery || null,
	})
	if (!trimmedQuery) {
		const withAggregates = await attachListingAggregatesBatch(
			input.env.APP_DB,
			listings,
		)
		return withAggregates
			.sort(compareCommunityListingsByBayesianAndPublishedAt)
			.slice(0, input.limit)
	}
	const matchesQuery = (listing: CommunityListingRecord) =>
		isCommunityListingSearchMatch({
			query: trimmedQuery,
			document: buildListingSearchDocument(listing),
		})
	let matched = listings.filter(matchesQuery)
	const prefilterApplied =
		extractCommunityListingLikeTokens(trimmedQuery).length > 0
	if (matched.length === 0 && prefilterApplied) {
		// The SQL LIKE pre-filter produced no scoring matches; fall back to a
		// bounded recent candidate set so vector-threshold matches among other
		// recent listings keep working. Skipped when the first query was
		// already unfiltered (no LIKE tokens), since it would return the same
		// candidates.
		listings = await listCommunityListingCandidates(input.env.APP_DB, {
			includeDelisted: false,
			limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
		})
		matched = listings.filter(matchesQuery)
	}
	const withAggregates = await attachListingAggregatesBatch(
		input.env.APP_DB,
		matched,
	)
	const queryEmbedding = deterministicEmbedding(trimmedQuery)
	const scored = withAggregates.map((listing) => {
		const document = buildListingSearchDocument(listing)
		const lexical = lexicalScore(trimmedQuery, document)
		const vector = cosineSimilarity(
			queryEmbedding,
			deterministicEmbedding(document),
		)
		const blended = blendLexicalAndVectorScore(lexical, vector)
		const bayesian = computeCommunityBayesianScore({
			averageStars: listing.averageStars,
			ratingCount: listing.ratingCount,
		})
		return {
			listing,
			score: blended * bayesian,
		}
	})

	return scored
		.sort((left, right) => right.score - left.score)
		.slice(0, input.limit)
		.map((entry) => entry.listing)
}

export async function forkCommunityListing(input: {
	env: Env
	baseUrl: string
	userId: string
	expectedPackageScope: string
	listingId: string
	kodyId?: string
}): Promise<ForkCommunityListingResult> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) {
		throw new Error(`Community listing "${input.listingId}" was not found.`)
	}

	const snapshot = await readCommunitySnapshot(
		input.env.BUNDLE_ARTIFACTS_KV,
		input.listingId,
	)
	if (!snapshot) {
		throw new Error(
			`Community listing snapshot for "${input.listingId}" was not found.`,
		)
	}

	const packageJsonContent = snapshot.files['package.json']
	if (!packageJsonContent) {
		throw new Error('Community listing snapshot is missing package.json.')
	}

	const targetKodyId = input.kodyId?.trim() || listing.kodyId
	const rewrittenManifest = rewritePackageManifestForFork({
		manifestContent: packageJsonContent,
		expectedPackageScope: input.expectedPackageScope,
		targetKodyId,
	})
	const existingByKody = await getSavedPackageByKodyId(input.env.APP_DB, {
		userId: input.userId,
		kodyId: targetKodyId,
	})
	const existingByName = await getSavedPackageByName(input.env.APP_DB, {
		userId: input.userId,
		name: rewrittenManifest.targetName,
	})
	if (existingByKody || existingByName) {
		throw new CommunityActionError(
			`You already have a saved package with kody id "${targetKodyId}". Pass a different kody_id to fork this listing.`,
		)
	}

	const existingForks = await listCommunityForksByListingAndUser(
		input.env.APP_DB,
		{
			listingId: input.listingId,
			userId: input.userId,
		},
	)
	const collidingFork = existingForks.find(
		(fork) => fork.targetKodyId === targetKodyId,
	)
	if (collidingFork) {
		throw new CommunityActionError(
			buildRepeatForkErrorMessage({
				targetKodyId,
				forkedSourceId: collidingFork.forkedSourceId,
				forkedPackageId: collidingFork.forkedPackageId,
			}),
		)
	}

	const rewrittenFiles = {
		...snapshot.files,
		'package.json': rewrittenManifest.content,
	}
	const crossScopeReferences = scanCrossScopeReferences({
		files: rewrittenFiles,
		expectedPackageScope: input.expectedPackageScope,
	})

	const packageId = crypto.randomUUID()
	const ensuredSource = await ensureEntitySource({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		entityKind: 'package',
		entityId: packageId,
		requirePersistence: true,
	})
	try {
		await syncArtifactSourceSnapshot({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: ensuredSource.id,
			files: rewrittenFiles,
			bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
		})

		const forkId = crypto.randomUUID()
		await insertCommunityFork(input.env.APP_DB, {
			id: forkId,
			listing_id: input.listingId,
			forker_user_id: input.userId,
			origin_commit: listing.pinnedCommit,
			forked_package_id: packageId,
			forked_source_id: ensuredSource.id,
			target_kody_id: targetKodyId,
		})

		invalidateCommunityPublicCache()

		return {
			forkId,
			packageId,
			sourceId: ensuredSource.id,
			targetKodyId,
			targetName: rewrittenManifest.targetName,
			originCommit: listing.pinnedCommit,
			crossScopeReferences,
			filesCount: Object.keys(rewrittenFiles).length,
		}
	} catch (error) {
		await cleanupFailedCommunityFork({
			env: input.env,
			userId: input.userId,
			sourceId: ensuredSource.id,
			packageId,
		})
		throw error
	}
}

export async function rateCommunityListing(input: {
	env: Env
	userId: string
	listingId: string
	stars: number
	adaptationEffort: number
	note?: string
}): Promise<void> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) {
		throw new Error(`Community listing "${input.listingId}" was not found.`)
	}
	if (listing.ownerUserId === input.userId) {
		throw new CommunityActionError('You cannot rate your own listing.')
	}

	const fork = await getCommunityForkByListingAndUser(input.env.APP_DB, {
		listingId: input.listingId,
		userId: input.userId,
	})
	if (!fork) {
		throw new Error('rate after forking')
	}

	await upsertCommunityRating(input.env.APP_DB, {
		id: crypto.randomUUID(),
		listing_id: input.listingId,
		user_id: input.userId,
		stars: input.stars,
		adaptation_effort: input.adaptationEffort,
		note: input.note?.trim() || null,
	})
	invalidateCommunityPublicCache()
}

export async function reportCommunityListing(input: {
	env: Env
	userId: string
	listingId: string
	reason: string
}): Promise<CommunityReportRecord> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: true,
	})
	if (!listing) {
		throw new CommunityActionError(
			`Community listing "${input.listingId}" was not found.`,
		)
	}

	const trimmedReason = input.reason.trim()
	if (trimmedReason.length < 1 || trimmedReason.length > 2_000) {
		throw new CommunityActionError(
			'Report reason must be between 1 and 2000 characters.',
		)
	}

	const reportId = crypto.randomUUID()
	await insertCommunityReport(input.env.APP_DB, {
		id: reportId,
		listing_id: listing.id,
		listing_name: listing.name,
		listing_owner_user_id: listing.ownerUserId,
		reporter_user_id: input.userId,
		reason: trimmedReason,
		status: 'open',
		resolved_by_user_id: null,
		resolved_at: null,
		resolution_note: null,
	})

	const report = await getCommunityReportById(input.env.APP_DB, reportId)
	if (!report) {
		throw new Error(`Community report "${reportId}" could not be loaded.`)
	}
	return report
}

export async function listCommunityReports(input: {
	env: Env
	status?: CommunityReportRecord['status']
}): Promise<Array<CommunityReportRecord>> {
	return await listCommunityReportsFromDb(input.env.APP_DB, {
		status: input.status,
	})
}

export async function resolveCommunityReport(input: {
	env: Env
	adminUserId: string
	reportId: string
	action: CommunityReportResolutionAction
	resolutionNote?: string
}): Promise<void> {
	const report = await getCommunityReportById(input.env.APP_DB, input.reportId)
	if (!report || report.status !== 'open') {
		throw new CommunityActionError(
			`Community report "${input.reportId}" was not found.`,
		)
	}

	switch (input.action) {
		case 'dismiss': {
			const resolved = await resolveCommunityReportRow(input.env.APP_DB, {
				reportId: input.reportId,
				status: 'dismissed',
				resolvedByUserId: input.adminUserId,
				resolutionNote: input.resolutionNote ?? null,
			})
			if (!resolved) {
				throw new CommunityActionError(
					`Community report "${input.reportId}" was not found.`,
				)
			}
			return
		}
		case 'delist': {
			await setCommunityListingStatus(input.env.APP_DB, {
				listingId: report.listingId,
				status: 'delisted',
			})
			invalidateCommunityPublicCache()
			const resolved = await resolveCommunityReportRow(input.env.APP_DB, {
				reportId: input.reportId,
				status: 'resolved',
				resolvedByUserId: input.adminUserId,
				resolutionNote: input.resolutionNote ?? null,
			})
			if (!resolved) {
				throw new CommunityActionError(
					`Community report "${input.reportId}" was not found.`,
				)
			}
			return
		}
		case 'delete': {
			// Hard delete removes listing metadata, ratings, and KV snapshot only.
			// Fork rows are preserved for provenance and the rate-after-fork gate;
			// report rows stay denormalized so moderation history survives deletion.
			const deleted = await deleteCommunityListing(input.env.APP_DB, {
				listingId: report.listingId,
			})
			if (!deleted) {
				console.error(
					`Community listing "${report.listingId}" was already deleted during report resolution.`,
				)
			} else {
				await deleteCommunityRatingsByListingId(
					input.env.APP_DB,
					report.listingId,
				)
				await deleteCommunitySnapshot(
					input.env.BUNDLE_ARTIFACTS_KV,
					report.listingId,
				)
				invalidateCommunityPublicCache()
			}
			const resolved = await resolveCommunityReportRow(input.env.APP_DB, {
				reportId: input.reportId,
				status: 'resolved',
				resolvedByUserId: input.adminUserId,
				resolutionNote: input.resolutionNote ?? null,
			})
			if (!resolved) {
				throw new CommunityActionError(
					`Community report "${input.reportId}" was not found.`,
				)
			}
			return
		}
		default: {
			const unreachable: never = input.action
			throw new Error(`Unsupported report resolution action: ${unreachable}`)
		}
	}
}

export async function banCommunityUser(input: {
	env: Env
	adminUserId: string
	userId: string
	reason: string
}): Promise<void> {
	const trimmedReason = input.reason.trim()
	if (!trimmedReason) {
		throw new CommunityActionError('Ban reason is required.')
	}
	await insertCommunityBan(input.env.APP_DB, {
		user_id: input.userId,
		banned_by_user_id: input.adminUserId,
		reason: trimmedReason,
	})
}

export async function unbanCommunityUser(input: {
	env: Env
	userId: string
}): Promise<void> {
	const removed = await deleteCommunityBan(input.env.APP_DB, input.userId)
	if (!removed) {
		throw new Error(`Community ban for user "${input.userId}" was not found.`)
	}
}
