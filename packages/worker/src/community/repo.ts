import {
	type CommunityBanRecord,
	type CommunityBanRow,
	type CommunityForkRecord,
	type CommunityForkRow,
	type CommunityListingRecord,
	type CommunityListingRow,
	type CommunityListingStatus,
	type CommunityRatingAggregate,
	type CommunityRatingRow,
	type CommunityReportRecord,
	type CommunityReportRow,
	type CommunityReportStatus,
} from './types.ts'

function parseTagsJson(raw: unknown) {
	if (raw == null) return []
	const parsed = JSON.parse(String(raw)) as unknown
	return Array.isArray(parsed)
		? parsed
				.filter((value): value is string => typeof value === 'string')
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: []
}

function mapCommunityListingRow(
	row: Record<string, unknown>,
): CommunityListingRecord {
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
		pinnedCommit: String(row['pinned_commit']),
		status: String(row['status']) as CommunityListingStatus,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		publishedAt: String(row['published_at']),
	}
}

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
	}
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
	return includeDelisted ? '' : `WHERE status = 'active'`
}

export async function insertCommunityListing(
	db: D1Database,
	row: Omit<
		CommunityListingRow,
		'created_at' | 'updated_at' | 'published_at'
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
	const statusClause = input.includeDelisted ? '' : `AND status = 'active'`
	const row = await db
		.prepare(
			`SELECT id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, search_text, readme_content, license, pinned_commit, status,
				created_at, updated_at, published_at
			FROM community_listings
			WHERE id = ? ${statusClause}`,
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
			`SELECT id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, search_text, readme_content, license, pinned_commit, status,
				created_at, updated_at, published_at
			FROM community_listings
			WHERE owner_user_id = ? AND package_id = ?`,
		)
		.bind(input.ownerUserId, input.packageId)
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
			`SELECT id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, search_text, readme_content, license, pinned_commit, status,
				created_at, updated_at, published_at
			FROM community_listings
			${listingStatusFilter(input.includeDelisted)}
			ORDER BY published_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(input.limit, input.offset)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapCommunityListingRow)
}

export async function listAllCommunityListings(
	db: D1Database,
	input: {
		includeDelisted: boolean
	},
): Promise<Array<CommunityListingRecord>> {
	const rows = await db
		.prepare(
			`SELECT id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, search_text, readme_content, license, pinned_commit, status,
				created_at, updated_at, published_at
			FROM community_listings
			${listingStatusFilter(input.includeDelisted)}
			ORDER BY published_at DESC`,
		)
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
	row: Omit<CommunityForkRow, 'created_at'> & { created_at?: string },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO community_forks (
				id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.listing_id,
			row.forker_user_id,
			row.origin_commit,
			row.forked_package_id,
			row.forked_source_id,
			row.target_kody_id,
			row.created_at ?? new Date().toISOString(),
		)
		.run()
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
			`SELECT id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, created_at
			FROM community_forks
			WHERE listing_id = ? AND forker_user_id = ?`,
		)
		.bind(input.listingId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapCommunityForkRow(row) : null
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
			`SELECT id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, created_at
			FROM community_forks
			WHERE listing_id = ? AND forker_user_id = ?
			ORDER BY created_at ASC`,
		)
		.bind(input.listingId, input.userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map((row) => mapCommunityForkRow(row))
}

export async function countCommunityForksByListingIds(
	db: D1Database,
	listingIds: Array<string>,
): Promise<Record<string, number>> {
	if (listingIds.length === 0) return {}
	const placeholders = listingIds.map(() => '?').join(', ')
	const rows = await db
		.prepare(
			`SELECT listing_id, COUNT(*) AS fork_count
			FROM community_forks
			WHERE listing_id IN (${placeholders})
			GROUP BY listing_id`,
		)
		.bind(...listingIds)
		.all<Record<string, unknown>>()
	const counts: Record<string, number> = Object.fromEntries(
		listingIds.map((listingId) => [listingId, 0]),
	)
	for (const row of rows.results ?? []) {
		counts[String(row['listing_id'])] = Number(row['fork_count'] ?? 0)
	}
	return counts
}

export async function upsertCommunityRating(
	db: D1Database,
	row: Omit<CommunityRatingRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO community_ratings (
				id, listing_id, user_id, stars, adaptation_effort, note, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(listing_id, user_id) DO UPDATE SET
				stars = excluded.stars,
				adaptation_effort = excluded.adaptation_effort,
				note = excluded.note,
				updated_at = excluded.updated_at`,
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
		.run()
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
	const placeholders = listingIds.map(() => '?').join(', ')
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
		.bind(...listingIds)
		.all<Record<string, unknown>>()
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
