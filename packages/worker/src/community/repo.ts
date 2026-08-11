import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import {
	type CommunityActivityKind,
	type CommunityActivityRecord,
	type CommunityBanRecord,
	type CommunityBanRow,
	type CommunityForkRecord,
	type CommunityForkActor,
	type CommunityForkRow,
	type CommunityListingRecord,
	type CommunityListingRow,
	type CommunityListingStatus,
	type CommunityRatingAggregate,
	type CommunityRatingRecord,
	type CommunityRatingRow,
	type CommunityReportRecord,
	type CommunityReportRow,
	type CommunityReportStatus,
} from './types.ts'

export function mapCommunityListingRow(
	row: Record<string, unknown>,
): CommunityListingRecord {
	const pinnedCommit = String(row['pinned_commit'])
	const trustedCommit =
		row['trusted_commit'] == null ? null : String(row['trusted_commit'])
	const trusted = trustedCommit != null && trustedCommit === pinnedCommit
	const featuredAt =
		row['featured_at'] == null ? null : String(row['featured_at'])
	return {
		id: String(row['id']),
		ownerUserId: String(row['owner_user_id']),
		packageId: String(row['package_id']),
		sourceId: String(row['source_id']),
		kodyId: String(row['kody_id']),
		name: String(row['name']),
		description: String(row['description']),
		tags: parseTagsJson(row['tags_json']),
		searchText:
			row['search_text'] == null ? null : String(row['search_text']).trim(),
		readmeContent:
			row['readme_content'] == null ? null : String(row['readme_content']),
		license: String(row['license']),
		pinnedCommit,
		iconCommit:
			row['source_published_commit'] == null
				? pinnedCommit
				: String(row['source_published_commit']),
		status: String(row['status']) as CommunityListingStatus,
		trustedCommit,
		trustedAt: row['trusted_at'] == null ? null : String(row['trusted_at']),
		trusted,
		featuredAt,
		// Featured is an onboarding placement, so it never outlives trust: a
		// republish (or trust revocation) pulls the listing from onboarding
		// even though featured_at stays set.
		featured: featuredAt != null && trusted,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		publishedAt: String(row['published_at']),
	}
}

const communityForkSelectColumns = `id, listing_id, forker_user_id, origin_commit, forked_package_id,
	forked_source_id, target_kody_id, created_at, adopted_at, adoption_note`

function mapCommunityForkRow(
	row: Record<string, unknown>,
): CommunityForkRecord {
	return {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		forkerUserId: String(row['forker_user_id']),
		originCommit: String(row['origin_commit']),
		forkedPackageId: String(row['forked_package_id']),
		forkedSourceId: String(row['forked_source_id']),
		targetKodyId: String(row['target_kody_id']),
		createdAt: String(row['created_at']),
		adoptedAt: row['adopted_at'] == null ? null : String(row['adopted_at']),
		adoptionNote:
			row['adoption_note'] == null ? null : String(row['adoption_note']),
	}
}

function mapCommunityRatingRow(
	row: Record<string, unknown>,
): CommunityRatingRecord {
	return {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		userId: String(row['user_id']),
		stars: Number(row['stars']),
		adaptationEffort: Number(row['adaptation_effort']),
		note: row['note'] == null ? null : String(row['note']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapCommunityActivityRow(
	row: Record<string, unknown>,
): CommunityActivityRecord {
	const shared = {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		listingName: String(row['listing_name']),
		listingKodyId: String(row['listing_kody_id']),
		actingUsername:
			row['acting_username'] == null ? null : String(row['acting_username']),
		occurredAt: String(row['occurred_at']),
	}
	const kind = String(row['kind'])
	if (kind === 'fork') return { ...shared, kind }
	if (kind === 'rating') {
		return {
			...shared,
			kind,
			stars: Number(row['stars']),
			adaptationEffort: Number(row['adaptation_effort']),
		}
	}
	throw new Error(`Unsupported community activity kind: ${kind}`)
}

function mapCommunityReportRow(
	row: Record<string, unknown>,
): CommunityReportRecord {
	return {
		id: String(row['id']),
		listingId: String(row['listing_id']),
		listingName: String(row['listing_name']),
		listingOwnerUserId: String(row['listing_owner_user_id']),
		reporterUserId: String(row['reporter_user_id']),
		reason: String(row['reason']),
		status: String(row['status']) as CommunityReportStatus,
		resolvedByUserId:
			row['resolved_by_user_id'] == null
				? null
				: String(row['resolved_by_user_id']),
		resolvedAt: row['resolved_at'] == null ? null : String(row['resolved_at']),
		resolutionNote:
			row['resolution_note'] == null ? null : String(row['resolution_note']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapCommunityBanRow(row: Record<string, unknown>): CommunityBanRecord {
	return {
		userId: String(row['user_id']),
		bannedByUserId: String(row['banned_by_user_id']),
		reason: String(row['reason']),
		createdAt: String(row['created_at']),
	}
}

function listingStatusFilter(includeDelisted: boolean) {
	return includeDelisted ? '' : `WHERE community_listings.status = 'active'`
}

/**
 * Listing reads join the owner package's entity source so the icon commit
 * (`source_published_commit`) tracks the latest package publish. The join is
 * scoped to the listing owner + package so a foreign source row can never
 * leak a commit into another user's listing.
 */
export const communityListingSelectColumns = `community_listings.id, community_listings.owner_user_id,
	community_listings.package_id, community_listings.source_id, community_listings.kody_id,
	community_listings.name, community_listings.description, community_listings.tags_json,
	community_listings.search_text, community_listings.readme_content, community_listings.license,
	community_listings.pinned_commit, community_listings.status, community_listings.created_at,
	community_listings.updated_at, community_listings.published_at,
	community_listings.trusted_commit, community_listings.trusted_by_user_id,
	community_listings.trusted_at, community_listings.featured_at,
	entity_sources.published_commit AS source_published_commit`

export const communityListingSourceJoin = `LEFT JOIN entity_sources
	ON entity_sources.id = community_listings.source_id
	AND entity_sources.user_id = community_listings.owner_user_id
	AND entity_sources.entity_kind = 'package'
	AND entity_sources.entity_id = community_listings.package_id`

// D1 caps bound parameters per statement, so IN (...) lookups over large id
// sets are issued in chunks (90 leaves headroom for fixed bindings).
const maxSqlBindingsPerChunk = 90

const communityActivityUnion = `SELECT
	community_forks.id AS id,
	'fork' AS kind,
	community_forks.listing_id AS listing_id,
	COALESCE(
		community_listings.name,
		community_forks.listing_name,
		'[deleted listing]'
	) AS listing_name,
	COALESCE(
		community_listings.kody_id,
		community_forks.listing_kody_id,
		'[unknown]'
	) AS listing_kody_id,
	users.username AS acting_username,
	community_forks.created_at AS occurred_at,
	NULL AS stars,
	NULL AS adaptation_effort
FROM community_forks
LEFT JOIN community_listings
	ON community_listings.id = community_forks.listing_id
LEFT JOIN users
	ON users.stable_user_id = community_forks.forker_user_id
UNION ALL
SELECT
	community_ratings.id AS id,
	'rating' AS kind,
	community_listings.id AS listing_id,
	community_listings.name AS listing_name,
	community_listings.kody_id AS listing_kody_id,
	users.username AS acting_username,
	community_ratings.updated_at AS occurred_at,
	community_ratings.stars AS stars,
	community_ratings.adaptation_effort AS adaptation_effort
FROM community_ratings
INNER JOIN community_listings
	ON community_listings.id = community_ratings.listing_id
LEFT JOIN users
	ON users.stable_user_id = community_ratings.user_id`

function buildCommunityActivityFilters(input: {
	kind?: CommunityActivityKind
	listingId?: string
}) {
	const filters: Array<string> = []
	const bindings: Array<unknown> = []
	if (input.kind !== undefined) {
		filters.push('activity.kind = ?')
		bindings.push(input.kind)
	}
	if (input.listingId !== undefined) {
		filters.push('activity.listing_id = ?')
		bindings.push(input.listingId)
	}
	return {
		where: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '',
		bindings,
	}
}

const communityListingSearchTextColumns = [
	'name',
	'kody_id',
	'description',
	'search_text',
	'tags_json',
	'readme_content',
] as const

const maxCommunityListingLikeTokens = 8

export function extractCommunityListingLikeTokens(
	query: string,
): Array<string> {
	// Tokens are restricted to [a-z0-9]+ so they are safe to embed inside
	// LIKE patterns without wildcard escaping.
	return Array.from(
		new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []),
	).slice(0, maxCommunityListingLikeTokens)
}

export async function insertCommunityListing(
	db: D1Database,
	// New listings are never trusted or featured; those columns start NULL
	// and are only set through setCommunityListingTrustedCommit /
	// setCommunityListingFeaturedAt.
	row: Omit<
		CommunityListingRow,
		| 'created_at'
		| 'updated_at'
		| 'published_at'
		| 'trusted_commit'
		| 'trusted_by_user_id'
		| 'trusted_at'
		| 'featured_at'
	> & {
		created_at?: string
		updated_at?: string
		published_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO community_listings (
				id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, search_text, readme_content, license, pinned_commit, status,
				created_at, updated_at, published_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.owner_user_id,
			row.package_id,
			row.source_id,
			row.kody_id,
			row.name,
			row.description,
			row.tags_json,
			row.search_text ?? null,
			row.readme_content ?? null,
			row.license,
			row.pinned_commit,
			row.status,
			row.created_at ?? now,
			row.updated_at ?? now,
			row.published_at ?? now,
		)
		.run()
}

export async function updateCommunityListing(
	db: D1Database,
	input: {
		listingId: string
		ownerUserId: string
		sourceId?: string
		kodyId?: string
		name?: string
		description?: string
		tagsJson?: string
		searchText?: string | null
		readmeContent?: string | null
		license?: string
		pinnedCommit?: string
		status?: CommunityListingStatus
		publishedAt?: string
		requireStatus?: CommunityListingStatus
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []

	function addAssignment(column: string, value: unknown) {
		assignments.push(`${column} = ?`)
		values.push(value)
	}

	if (input.sourceId !== undefined) addAssignment('source_id', input.sourceId)
	if (input.kodyId !== undefined) addAssignment('kody_id', input.kodyId)
	if (input.name !== undefined) addAssignment('name', input.name)
	if (input.description !== undefined) {
		addAssignment('description', input.description)
	}
	if (input.tagsJson !== undefined) addAssignment('tags_json', input.tagsJson)
	if (input.searchText !== undefined) {
		addAssignment('search_text', input.searchText ?? null)
	}
	if (input.readmeContent !== undefined) {
		addAssignment('readme_content', input.readmeContent ?? null)
	}
	if (input.license !== undefined) addAssignment('license', input.license)
	if (input.pinnedCommit !== undefined) {
		addAssignment('pinned_commit', input.pinnedCommit)
	}
	if (input.status !== undefined) addAssignment('status', input.status)
	if (input.publishedAt !== undefined) {
		addAssignment('published_at', input.publishedAt)
	}
	addAssignment('updated_at', new Date().toISOString())

	const statusClause = input.requireStatus != null ? ' AND status = ?' : ''
	const statusBindings =
		input.requireStatus != null ? [input.requireStatus] : []

	const result = await db
		.prepare(
			`UPDATE community_listings
			SET ${assignments.join(', ')}
			WHERE id = ? AND owner_user_id = ?${statusClause}`,
		)
		.bind(...values, input.listingId, input.ownerUserId, ...statusBindings)
		.run()

	return (result.meta.changes ?? 0) > 0
}

export async function getCommunityListingById(
	db: D1Database,
	input: {
		listingId: string
		includeDelisted: boolean
	},
): Promise<CommunityListingRecord | null> {
	const statusClause = input.includeDelisted
		? ''
		: `AND community_listings.status = 'active'`
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.id = ? ${statusClause}`,
		)
		.bind(input.listingId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityListingRow(row) : null
}

export async function getCommunityListingByOwnerAndPackage(
	db: D1Database,
	input: {
		ownerUserId: string
		packageId: string
	},
): Promise<CommunityListingRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.owner_user_id = ? AND community_listings.package_id = ?`,
		)
		.bind(input.ownerUserId, input.packageId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityListingRow(row) : null
}

/**
 * Lookup behind the canonical `/@owner/kody-id` URL. Only active listings are
 * addressable that way: a delisted listing releases the pair (and the partial
 * unique index that guards it), so a republish can take the URL over.
 */
export async function getCommunityListingByOwnerAndKodyId(
	db: D1Database,
	input: {
		ownerUserId: string
		kodyId: string
	},
): Promise<CommunityListingRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.owner_user_id = ?
				AND community_listings.kody_id = ?
				AND community_listings.status = 'active'`,
		)
		.bind(input.ownerUserId, input.kodyId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityListingRow(row) : null
}

export async function listCommunityListings(
	db: D1Database,
	input: {
		includeDelisted: boolean
		limit: number
		offset: number
	},
): Promise<Array<CommunityListingRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			${listingStatusFilter(input.includeDelisted)}
			ORDER BY community_listings.published_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(input.limit, input.offset)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

/**
 * Bounded candidate query for community search/browse. Applies SQL-level text
 * pre-filtering (LIKE across name/kody_id/description/search_text/tags_json/
 * readme_content) when a query is provided, orders by recency, and never
 * returns more than `limit` rows so scoring stays off the full table.
 */
export async function listCommunityListingCandidates(
	db: D1Database,
	input: {
		includeDelisted: boolean
		limit: number
		query?: string | null
	},
): Promise<Array<CommunityListingRecord>> {
	const conditions: Array<string> = []
	const bindings: Array<unknown> = []
	if (!input.includeDelisted) {
		conditions.push(`community_listings.status = 'active'`)
	}
	const tokens = extractCommunityListingLikeTokens(input.query ?? '')
	if (tokens.length > 0) {
		const tokenClauses = tokens.map((token) => {
			const pattern = `%${token}%`
			const columnClauses = communityListingSearchTextColumns.map((column) => {
				bindings.push(pattern)
				return `community_listings.${column} LIKE ?`
			})
			return `(${columnClauses.join(' OR ')})`
		})
		conditions.push(`(${tokenClauses.join(' OR ')})`)
	}
	const whereClause =
		conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			${whereClause}
			ORDER BY community_listings.published_at DESC
			LIMIT ?`,
		)
		.bind(...bindings, input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

export async function deleteCommunityListing(
	db: D1Database,
	input: {
		listingId: string
		ownerUserId?: string
	},
): Promise<boolean> {
	const ownerClause = input.ownerUserId != null ? 'AND owner_user_id = ?' : ''
	const bindings =
		input.ownerUserId != null
			? [input.listingId, input.ownerUserId]
			: [input.listingId]
	const result = await db
		.prepare(`DELETE FROM community_listings WHERE id = ? ${ownerClause}`)
		.bind(...bindings)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function setCommunityListingTrustedCommit(
	db: D1Database,
	input: {
		listingId: string
		trustedCommit: string | null
		trustedByUserId: string | null
	},
): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await db
		.prepare(
			`UPDATE community_listings
			SET trusted_commit = ?, trusted_by_user_id = ?, trusted_at = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			input.trustedCommit,
			input.trustedCommit == null ? null : input.trustedByUserId,
			input.trustedCommit == null ? null : now,
			now,
			input.listingId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function setCommunityListingFeaturedAt(
	db: D1Database,
	input: {
		listingId: string
		featured: boolean
	},
): Promise<boolean> {
	const now = new Date().toISOString()
	// Re-featuring keeps the original timestamp (COALESCE) so idempotent
	// retries never reshuffle the featured_at-ordered onboarding list.
	const result = await db
		.prepare(
			`UPDATE community_listings
			SET featured_at = CASE WHEN ? THEN COALESCE(featured_at, ?) ELSE NULL END,
				updated_at = ?
			WHERE id = ?`,
		)
		.bind(input.featured ? 1 : 0, now, now, input.listingId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Listings that should be offered as onboarding starter packages: featured
 * by an admin AND still effectively trusted (the trusted commit matches the
 * pinned commit). Ordered by when they were featured so the curated order
 * stays stable as new packages are added.
 */
export async function listFeaturedCommunityListings(
	db: D1Database,
	input: {
		limit: number
	},
): Promise<Array<CommunityListingRecord>> {
	const rows = await db
		.prepare(
			`SELECT ${communityListingSelectColumns}
			FROM community_listings
			${communityListingSourceJoin}
			WHERE community_listings.status = 'active'
				AND community_listings.featured_at IS NOT NULL
				AND community_listings.trusted_commit = community_listings.pinned_commit
			ORDER BY community_listings.featured_at ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

export async function setCommunityListingStatus(
	db: D1Database,
	input: {
		listingId: string
		status: CommunityListingStatus
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE community_listings
			SET status = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(input.status, new Date().toISOString(), input.listingId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertCommunityFork(
	db: D1Database,
	row: Omit<
		CommunityForkRow,
		'created_at' | 'adopted_at' | 'adoption_note' | 'actor'
	> & {
		listing_name: string
		listing_kody_id: string
		created_at?: string
		actor?: CommunityForkActor | null
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO community_forks (
				id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, listing_name, listing_kody_id,
				created_at, actor
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.forker_user_id,
			row.origin_commit,
			row.forked_package_id,
			row.forked_source_id,
			row.target_kody_id,
			row.listing_name,
			row.listing_kody_id,
			row.created_at ?? new Date().toISOString(),
			row.actor ?? null,
		)
		.run()
}

export async function repointOrphanedCommunityForksToListing(
	db: D1Database,
	input: {
		listingId: string
		listingName: string
		listingKodyId: string
	},
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE community_forks
			SET listing_id = ?
			WHERE listing_id != ?
				AND listing_name = ?
				AND listing_kody_id = ?
				AND NOT EXISTS (
					SELECT 1
					FROM community_listings
					WHERE community_listings.id = community_forks.listing_id
				)`,
		)
		.bind(
			input.listingId,
			input.listingId,
			input.listingName,
			input.listingKodyId,
		)
		.run()
	return result.meta.changes ?? 0
}

export async function getCommunityForkByListingAndUser(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<CommunityForkRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE listing_id = ? AND forker_user_id = ?`,
		)
		.bind(input.listingId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityForkRow(row) : null
}

export async function getCommunityForkByForkedPackageId(
	db: D1Database,
	input: {
		forkerUserId: string
		forkedPackageId: string
	},
): Promise<CommunityForkRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE forked_package_id = ? AND forker_user_id = ?`,
		)
		.bind(input.forkedPackageId, input.forkerUserId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityForkRow(row) : null
}

export async function markCommunityForkAdopted(
	db: D1Database,
	input: {
		forkerUserId: string
		forkedPackageId: string
		adoptionNote: string
		adoptedAt: string
	},
): Promise<CommunityForkRecord | null> {
	const result = await db
		.prepare(
			`UPDATE community_forks
			SET adopted_at = ?, adoption_note = ?
			WHERE forked_package_id = ? AND forker_user_id = ?`,
		)
		.bind(
			input.adoptedAt,
			input.adoptionNote,
			input.forkedPackageId,
			input.forkerUserId,
		)
		.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return getCommunityForkByForkedPackageId(db, {
		forkerUserId: input.forkerUserId,
		forkedPackageId: input.forkedPackageId,
	})
}

export async function listCommunityForksByListingAndUser(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<Array<CommunityForkRecord>> {
	const result = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE listing_id = ? AND forker_user_id = ?
			ORDER BY created_at ASC`,
		)
		.bind(input.listingId, input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map((row) => mapCommunityForkRow(row))
}

/**
 * Viewer forks for a set of listings. `ORDER BY created_at` applies inside
 * each D1 chunk only; callers that need a global order must sort themselves.
 */
export async function listCommunityForksByListingIdsAndUser(
	db: D1Database,
	input: {
		listingIds: Array<string>
		userId: string
	},
): Promise<Array<CommunityForkRecord>> {
	if (input.listingIds.length === 0) return []
	const uniqueListingIds = [...new Set(input.listingIds)]
	const forks: Array<CommunityForkRecord> = []
	for (const idChunk of chunkArray(
		uniqueListingIds,
		maxSqlBindingsPerChunk - 1,
	)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${communityForkSelectColumns}
				FROM community_forks
				WHERE forker_user_id = ? AND listing_id IN (${placeholders})
				ORDER BY created_at ASC`,
			)
			.bind(input.userId, ...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			forks.push(mapCommunityForkRow(row))
		}
	}
	return forks
}

export async function countCommunityForksByListingIds(
	db: D1Database,
	listingIds: Array<string>,
): Promise<Record<string, number>> {
	if (listingIds.length === 0) return {}
	const counts: Record<string, number> = Object.fromEntries(
		listingIds.map((listingId) => [listingId, 0]),
	)
	for (const idChunk of chunkArray(listingIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT listing_id, COUNT(*) AS fork_count
				FROM community_forks
				WHERE listing_id IN (${placeholders})
				GROUP BY listing_id`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			counts[String(row['listing_id'])] = Number(row['fork_count'] ?? 0)
		}
	}
	return counts
}

export async function listCommunityActivityRowsForAdmin(
	db: D1Database,
	input: {
		page: number
		pageSize: number
		kind?: CommunityActivityKind
		listingId?: string
	},
): Promise<{
	total: number
	items: Array<CommunityActivityRecord>
}> {
	const filters = buildCommunityActivityFilters(input)
	const count = await db
		.prepare(
			`SELECT COUNT(*) AS total
			FROM (${communityActivityUnion}) AS activity
			${filters.where}`,
		)
		.bind(...filters.bindings)
		.first<{ total: number }>()
	const items = await listCommunityActivityPageRowsForAdmin(db, input)
	return { total: Number(count?.total ?? 0), items }
}

export async function listCommunityActivityPageRowsForAdmin(
	db: D1Database,
	input: {
		page: number
		pageSize: number
		kind?: CommunityActivityKind
		listingId?: string
	},
): Promise<Array<CommunityActivityRecord>> {
	const filters = buildCommunityActivityFilters(input)
	const result = await db
		.prepare(
			`SELECT activity.*
			FROM (${communityActivityUnion}) AS activity
			${filters.where}
			ORDER BY activity.occurred_at DESC, activity.id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(
			...filters.bindings,
			input.pageSize,
			(input.page - 1) * input.pageSize,
		)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapCommunityActivityRow)
}

export async function getCommunityActivityByIdForAdmin(
	db: D1Database,
	input: { kind: CommunityActivityKind; activityId: string },
): Promise<CommunityActivityRecord | null> {
	const row = await db
		.prepare(
			`SELECT activity.*
			FROM (${communityActivityUnion}) AS activity
			WHERE activity.kind = ? AND activity.id = ?`,
		)
		.bind(input.kind, input.activityId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityActivityRow(row) : null
}

export async function upsertCommunityRating(
	db: D1Database,
	row: Omit<CommunityRatingRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<CommunityRatingRecord> {
	const now = new Date().toISOString()
	const persisted = await db
		.prepare(
			`INSERT INTO community_ratings (
				id, listing_id, user_id, stars, adaptation_effort, note, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(listing_id, user_id) DO UPDATE SET
				stars = excluded.stars,
				adaptation_effort = excluded.adaptation_effort,
				note = excluded.note,
				updated_at = excluded.updated_at
			RETURNING id, listing_id, user_id, stars, adaptation_effort, note,
				created_at, updated_at`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.user_id,
			row.stars,
			row.adaptation_effort,
			row.note ?? null,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.first<Record<string, unknown>>()
	if (!persisted) {
		throw new Error('Community rating upsert did not return a row.')
	}
	return mapCommunityRatingRow(persisted)
}

export async function deleteCommunityRatingsByListingId(
	db: D1Database,
	listingId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_ratings WHERE listing_id = ?`)
		.bind(listingId)
		.run()
}

export async function getCommunityRatingAggregatesByListingId(
	db: D1Database,
	listingId: string,
): Promise<CommunityRatingAggregate> {
	const row = await db
		.prepare(
			`SELECT
				COUNT(*) AS rating_count,
				AVG(stars) AS average_stars,
				AVG(adaptation_effort) AS average_adaptation_effort
			FROM community_ratings
			WHERE listing_id = ?`,
		)
		.bind(listingId)
		.first<Record<string, unknown>>()
	const ratingCount = Number(row?.['rating_count'] ?? 0)
	return {
		listingId,
		ratingCount,
		averageStars:
			ratingCount === 0 ? null : Number(row?.['average_stars'] ?? 0),
		averageAdaptationEffort:
			ratingCount === 0
				? null
				: Number(row?.['average_adaptation_effort'] ?? 0),
	}
}

export async function getCommunityRatingAggregatesByListingIds(
	db: D1Database,
	listingIds: Array<string>,
): Promise<Record<string, CommunityRatingAggregate>> {
	if (listingIds.length === 0) return {}
	const aggregates: Record<string, CommunityRatingAggregate> =
		Object.fromEntries(
			listingIds.map((listingId) => [
				listingId,
				{
					listingId,
					ratingCount: 0,
					averageStars: null,
					averageAdaptationEffort: null,
				},
			]),
		)
	for (const idChunk of chunkArray(listingIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT
					listing_id,
					COUNT(*) AS rating_count,
					AVG(stars) AS average_stars,
					AVG(adaptation_effort) AS average_adaptation_effort
				FROM community_ratings
				WHERE listing_id IN (${placeholders})
				GROUP BY listing_id`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			const listingId = String(row['listing_id'])
			const ratingCount = Number(row['rating_count'] ?? 0)
			aggregates[listingId] = {
				listingId,
				ratingCount,
				averageStars:
					ratingCount === 0 ? null : Number(row['average_stars'] ?? 0),
				averageAdaptationEffort:
					ratingCount === 0
						? null
						: Number(row['average_adaptation_effort'] ?? 0),
			}
		}
	}
	return aggregates
}

export async function insertCommunityReport(
	db: D1Database,
	row: Omit<CommunityReportRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO community_reports (
				id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
				reason, status, resolved_by_user_id, resolved_at, resolution_note,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.listing_name,
			row.listing_owner_user_id,
			row.reporter_user_id,
			row.reason,
			row.status,
			row.resolved_by_user_id ?? null,
			row.resolved_at ?? null,
			row.resolution_note ?? null,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function listCommunityReports(
	db: D1Database,
	input: {
		status?: CommunityReportStatus
	},
): Promise<Array<CommunityReportRecord>> {
	const statusClause = input.status != null ? 'WHERE status = ?' : ''
	const bindings = input.status != null ? [input.status] : []
	const rows = await db
		.prepare(
			`SELECT id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
				reason, status, resolved_by_user_id, resolved_at, resolution_note,
				created_at, updated_at
			FROM community_reports
			${statusClause}
			ORDER BY created_at DESC`,
		)
		.bind(...bindings)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityReportRow)
}

export async function getCommunityReportById(
	db: D1Database,
	reportId: string,
): Promise<CommunityReportRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
				reason, status, resolved_by_user_id, resolved_at, resolution_note,
				created_at, updated_at
			FROM community_reports
			WHERE id = ?`,
		)
		.bind(reportId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityReportRow(row) : null
}

export async function resolveCommunityReportRow(
	db: D1Database,
	input: {
		reportId: string
		status: Exclude<CommunityReportStatus, 'open'>
		resolvedByUserId: string
		resolutionNote?: string | null
	},
): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await db
		.prepare(
			`UPDATE community_reports
			SET status = ?, resolved_by_user_id = ?, resolved_at = ?, resolution_note = ?,
				updated_at = ?
			WHERE id = ? AND status = 'open'`,
		)
		.bind(
			input.status,
			input.resolvedByUserId,
			now,
			input.resolutionNote ?? null,
			now,
			input.reportId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertCommunityBan(
	db: D1Database,
	row: Omit<CommunityBanRow, 'created_at'> & { created_at?: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO community_bans (user_id, banned_by_user_id, reason, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				banned_by_user_id = excluded.banned_by_user_id,
				reason = excluded.reason,
				created_at = excluded.created_at`,
		)
		.bind(
			row.user_id,
			row.banned_by_user_id,
			row.reason,
			row.created_at ?? new Date().toISOString(),
		)
		.run()
}

export async function deleteCommunityBan(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM community_bans WHERE user_id = ?`)
		.bind(userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getCommunityBan(
	db: D1Database,
	userId: string,
): Promise<CommunityBanRecord | null> {
	const row = await db
		.prepare(
			`SELECT user_id, banned_by_user_id, reason, created_at
			FROM community_bans
			WHERE user_id = ?`,
		)
		.bind(userId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityBanRow(row) : null
}
