import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import { findUserRowByStableUserId } from '#worker/user-id.ts'
import {
	communityListingSelectColumns,
	communityListingSourceJoin,
	extractCommunityListingLikeTokens,
	mapCommunityListingRow,
} from './repo.ts'
import {
	type CommunityActivityEventType,
	type CommunityActivityItem,
	type CommunityListingRecord,
	type CommunityStargazer,
	type ProfileVisibility,
	type PublicProfilePackage,
} from './types.ts'

// D1 caps bound parameters per statement; 90 leaves headroom for fixed binds.
const maxSqlBindingsPerChunk = 90

export type UserSocialRow = {
	id: number
	username: string
	email: string
	stable_user_id: string | null
	display_name: string | null
	bio: string | null
	avatar_key: string | null
	profile_visibility: ProfileVisibility
	created_at: string
}

const userSocialSelectColumns = `id, username, email, stable_user_id, display_name, bio,
	avatar_key, profile_visibility, created_at`

function mapUserSocialRow(row: Record<string, unknown>): UserSocialRow {
	return {
		id: Number(row['id']),
		username: String(row['username']),
		email: String(row['email']),
		stable_user_id:
			row['stable_user_id'] == null ? null : String(row['stable_user_id']),
		display_name:
			row['display_name'] == null ? null : String(row['display_name']),
		bio: row['bio'] == null ? null : String(row['bio']),
		avatar_key: row['avatar_key'] == null ? null : String(row['avatar_key']),
		profile_visibility: String(row['profile_visibility']) as ProfileVisibility,
		created_at: String(row['created_at']),
	}
}

export function resolveCommunityDisplayName(input: {
	displayName: string | null
	username: string
}): string {
	const trimmed = input.displayName?.trim()
	if (trimmed) return trimmed
	return input.username
}

export async function getUserSocialRowByUsername(
	db: D1Database,
	username: string,
): Promise<UserSocialRow | null> {
	const row = await db
		.prepare(
			`SELECT ${userSocialSelectColumns}
			FROM users
			WHERE username = ?`,
		)
		.bind(username)
		.first<Record<string, unknown>>()
	return row ? mapUserSocialRow(row) : null
}

export async function getUserSocialRowByStableId(
	db: D1Database,
	stableUserId: string,
): Promise<UserSocialRow | null> {
	// Self-healing lookup: legacy rows whose stable_user_id column is still
	// NULL are found by hashing emails and get the id written back, so they
	// also start matching the raw stable-id joins used by stargazer and
	// timeline queries.
	const row = await findUserRowByStableUserId<
		UserSocialRow & Record<string, unknown>
	>({
		db,
		stableUserId,
		select: `SELECT ${userSocialSelectColumns} FROM users`,
	})
	return row ? mapUserSocialRow(row) : null
}

export async function updateUserProfileFields(
	db: D1Database,
	input: {
		numericUserId: number
		displayName?: string | null
		bio?: string | null
		visibility?: ProfileVisibility
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []

	if (input.displayName !== undefined) {
		assignments.push('display_name = ?')
		values.push(input.displayName)
	}
	if (input.bio !== undefined) {
		assignments.push('bio = ?')
		values.push(input.bio)
	}
	if (input.visibility !== undefined) {
		assignments.push('profile_visibility = ?')
		values.push(input.visibility)
	}
	if (assignments.length === 0) return false

	assignments.push('updated_at = ?')
	values.push(utcSqliteTimestamp())

	const result = await db
		.prepare(
			`UPDATE users
			SET ${assignments.join(', ')}
			WHERE id = ?`,
		)
		.bind(...values, input.numericUserId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function insertUserFollow(
	db: D1Database,
	input: {
		followerUserId: string
		followeeUserId: string
	},
): Promise<boolean> {
	// created_at is bound explicitly (not left to the SQLite CURRENT_TIMESTAMP
	// default) so follow/star rows use the same ISO-8601 format as activity
	// events and forks; the merged timeline sorts timestamps as strings.
	const result = await db
		.prepare(
			`INSERT INTO user_follows (follower_user_id, followee_user_id, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT(follower_user_id, followee_user_id) DO NOTHING`,
		)
		.bind(input.followerUserId, input.followeeUserId, new Date().toISOString())
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteUserFollow(
	db: D1Database,
	input: {
		followerUserId: string
		followeeUserId: string
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM user_follows
			WHERE follower_user_id = ? AND followee_user_id = ?`,
		)
		.bind(input.followerUserId, input.followeeUserId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getUserFollow(
	db: D1Database,
	input: {
		followerUserId: string
		followeeUserId: string
	},
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS present
			FROM user_follows
			WHERE follower_user_id = ? AND followee_user_id = ?`,
		)
		.bind(input.followerUserId, input.followeeUserId)
		.first<{ present: number }>()
	return row != null
}

export async function countUserFollowers(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM user_follows
			WHERE followee_user_id = ?`,
		)
		.bind(userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function countUserFollowing(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM user_follows
			WHERE follower_user_id = ?`,
		)
		.bind(userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

// Keep in sync with maxFollowingCount in social-service.ts.
const maxFolloweeIds = 2000

export async function listFolloweeUserIds(
	db: D1Database,
	followerUserId: string,
): Promise<Array<string>> {
	const rows = await db
		.prepare(
			`SELECT followee_user_id
			FROM user_follows
			WHERE follower_user_id = ?
			ORDER BY created_at DESC
			LIMIT ?`,
		)
		.bind(followerUserId, maxFolloweeIds)
		.all<{ followee_user_id: string }>()
	return (rows.results ?? []).map((row) => row.followee_user_id)
}

export async function insertCommunityStar(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<boolean> {
	// Explicit ISO created_at keeps star timestamps string-sortable against
	// activity events and forks in the merged timeline (see insertUserFollow).
	const result = await db
		.prepare(
			`INSERT INTO community_stars (listing_id, user_id, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT(listing_id, user_id) DO NOTHING`,
		)
		.bind(input.listingId, input.userId, new Date().toISOString())
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteCommunityStar(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM community_stars
			WHERE listing_id = ? AND user_id = ?`,
		)
		.bind(input.listingId, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getCommunityStar(
	db: D1Database,
	input: {
		listingId: string
		userId: string
	},
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS present
			FROM community_stars
			WHERE listing_id = ? AND user_id = ?`,
		)
		.bind(input.listingId, input.userId)
		.first<{ present: number }>()
	return row != null
}

export async function countCommunityStarsByListingIds(
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
				`SELECT listing_id, COUNT(*) AS star_count
				FROM community_stars
				WHERE listing_id IN (${placeholders})
				GROUP BY listing_id`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			counts[String(row['listing_id'])] = Number(row['star_count'] ?? 0)
		}
	}
	return counts
}

export async function listCommunityStargazers(
	db: D1Database,
	input: {
		listingId: string
		limit: number
	},
): Promise<Array<CommunityStargazer>> {
	const rows = await db
		.prepare(
			`SELECT s.user_id, s.created_at, u.username, u.display_name,
				u.avatar_key
			FROM community_stars s
			JOIN users u ON u.stable_user_id = s.user_id
				AND u.profile_visibility = 'public'
			WHERE s.listing_id = ?
			ORDER BY s.created_at DESC
			LIMIT ?`,
		)
		.bind(input.listingId, input.limit)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map((row) => {
		const username = String(row['username'])
		const displayName =
			row['display_name'] == null ? null : String(row['display_name'])
		return {
			userId: String(row['user_id']),
			username,
			displayName: resolveCommunityDisplayName({
				displayName,
				username,
			}),
			avatarKey: row['avatar_key'] == null ? null : String(row['avatar_key']),
			starredAt: String(row['created_at']),
		}
	})
}

export async function listStarredListingIdsByUser(
	db: D1Database,
	input: {
		userId: string
		limit: number
	},
): Promise<Array<string>> {
	const rows = await db
		.prepare(
			`SELECT listing_id
			FROM community_stars
			WHERE user_id = ?
			ORDER BY created_at DESC
			LIMIT ?`,
		)
		.bind(input.userId, input.limit)
		.all<{ listing_id: string }>()
	return (rows.results ?? []).map((row) => row.listing_id)
}

export async function insertCommunityActivityEvent(
	db: D1Database,
	input: {
		id: string
		actorUserId: string
		eventType: 'listing_published' | 'listing_updated'
		listingId: string
		createdAt?: string
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO community_activity_events (
				id, actor_user_id, event_type, listing_id, created_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.actorUserId,
			input.eventType,
			input.listingId,
			input.createdAt ?? new Date().toISOString(),
		)
		.run()
}

export async function deleteCommunityActivityEventsByListingId(
	db: D1Database,
	listingId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_activity_events WHERE listing_id = ?`)
		.bind(listingId)
		.run()
}

export async function deleteCommunityActivityEventsByActor(
	db: D1Database,
	actorUserId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_activity_events WHERE actor_user_id = ?`)
		.bind(actorUserId)
		.run()
}

export async function deleteUserFollowsForUser(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM user_follows
			WHERE follower_user_id = ? OR followee_user_id = ?`,
		)
		.bind(userId, userId)
		.run()
}

export async function deleteCommunityStarsByUser(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_stars WHERE user_id = ?`)
		.bind(userId)
		.run()
}

export async function deleteCommunityStarsByListingId(
	db: D1Database,
	listingId: string,
): Promise<void> {
	await db
		.prepare(`DELETE FROM community_stars WHERE listing_id = ?`)
		.bind(listingId)
		.run()
}

function mapActivityRow(
	row: Record<string, unknown>,
	type: CommunityActivityEventType,
): CommunityActivityItem {
	const username = String(row['username'])
	const displayName =
		row['display_name'] == null ? null : String(row['display_name'])
	return {
		type,
		actorUserId: String(row['actor_user_id']),
		actorUsername: username,
		actorDisplayName: resolveCommunityDisplayName({
			displayName,
			username,
		}),
		actorAvatarKey:
			row['avatar_key'] == null ? null : String(row['avatar_key']),
		listingId: String(row['listing_id']),
		listingName: String(row['listing_name']),
		listingKodyId: String(row['listing_kody_id']),
		createdAt: String(row['created_at']),
	}
}

function compareActivityItems(
	left: CommunityActivityItem,
	right: CommunityActivityItem,
): number {
	const byCreatedAt = right.createdAt.localeCompare(left.createdAt)
	if (byCreatedAt !== 0) return byCreatedAt
	const byType = left.type.localeCompare(right.type)
	if (byType !== 0) return byType
	const byListing = left.listingId.localeCompare(right.listingId)
	if (byListing !== 0) return byListing
	return left.actorUserId.localeCompare(right.actorUserId)
}

export async function listCommunityActivityForActors(
	db: D1Database,
	input: {
		actorUserIds: Array<string>
		limit: number
		requirePublicActorProfile: boolean
	},
): Promise<Array<CommunityActivityItem>> {
	if (input.actorUserIds.length === 0 || input.limit <= 0) return []

	const publicProfileClause = input.requirePublicActorProfile
		? `AND u.profile_visibility = 'public'`
		: ''
	const idChunks = chunkArray(input.actorUserIds, maxSqlBindingsPerChunk)
	const chunkResults = await Promise.all(
		idChunks.map(async (idChunk) => {
			const placeholders = idChunk.map(() => '?').join(', ')
			const items: Array<CommunityActivityItem> = []

			const [storedRows, forkRows, starRows] = await Promise.all([
				db
					.prepare(
						`SELECT e.event_type AS event_type, e.actor_user_id AS actor_user_id,
							e.created_at AS created_at, l.id AS listing_id, l.name AS listing_name,
							l.kody_id AS listing_kody_id, u.username, u.display_name,
							u.avatar_key
						FROM community_activity_events e
						JOIN community_listings l ON l.id = e.listing_id AND l.status = 'active'
						JOIN users u ON u.stable_user_id = e.actor_user_id ${publicProfileClause}
						WHERE e.actor_user_id IN (${placeholders})
						ORDER BY e.created_at DESC
						LIMIT ?`,
					)
					.bind(...idChunk, input.limit)
					.all<Record<string, unknown>>(),
				db
					.prepare(
						`SELECT 'listing_forked' AS event_type, f.forker_user_id AS actor_user_id,
							f.created_at AS created_at, l.id AS listing_id, l.name AS listing_name,
							l.kody_id AS listing_kody_id, u.username, u.display_name,
							u.avatar_key
						FROM community_forks f
						JOIN community_listings l ON l.id = f.listing_id AND l.status = 'active'
						JOIN saved_packages sp ON sp.id = f.forked_package_id
							AND sp.user_id = f.forker_user_id
							AND sp.is_private = 0
						JOIN users u ON u.stable_user_id = f.forker_user_id ${publicProfileClause}
						WHERE f.forker_user_id IN (${placeholders})
						ORDER BY f.created_at DESC
						LIMIT ?`,
					)
					.bind(...idChunk, input.limit)
					.all<Record<string, unknown>>(),
				db
					.prepare(
						`SELECT 'listing_starred' AS event_type, s.user_id AS actor_user_id,
							s.created_at AS created_at, l.id AS listing_id, l.name AS listing_name,
							l.kody_id AS listing_kody_id, u.username, u.display_name,
							u.avatar_key
						FROM community_stars s
						JOIN community_listings l ON l.id = s.listing_id AND l.status = 'active'
						JOIN users u ON u.stable_user_id = s.user_id ${publicProfileClause}
						WHERE s.user_id IN (${placeholders})
						ORDER BY s.created_at DESC
						LIMIT ?`,
					)
					.bind(...idChunk, input.limit)
					.all<Record<string, unknown>>(),
			])

			for (const row of storedRows.results ?? []) {
				const eventType = String(row['event_type'])
				if (
					eventType !== 'listing_published' &&
					eventType !== 'listing_updated'
				) {
					continue
				}
				items.push(mapActivityRow(row, eventType))
			}
			for (const row of forkRows.results ?? []) {
				items.push(mapActivityRow(row, 'listing_forked'))
			}
			for (const row of starRows.results ?? []) {
				items.push(mapActivityRow(row, 'listing_starred'))
			}
			return items
		}),
	)

	const items = chunkResults.flat()
	items.sort(compareActivityItems)
	return items.slice(0, input.limit)
}

export async function listCommunityListingsByIds(
	db: D1Database,
	listingIds: Array<string>,
): Promise<Array<CommunityListingRecord>> {
	if (listingIds.length === 0) return []
	const byId = new Map<string, CommunityListingRecord>()
	for (const idChunk of chunkArray(listingIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT ${communityListingSelectColumns}
				FROM community_listings
				${communityListingSourceJoin}
				WHERE community_listings.id IN (${placeholders})
					AND community_listings.status = 'active'`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of rows.results ?? []) {
			const listing = mapCommunityListingRow(row)
			byId.set(listing.id, listing)
		}
	}
	return listingIds.flatMap((listingId) => {
		const listing = byId.get(listingId)
		return listing ? [listing] : []
	})
}

export async function countPublicSavedPackagesForUser(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM saved_packages
			WHERE user_id = ? AND is_private = 0 AND hidden = 0`,
		)
		.bind(userId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function countActiveListingsForOwner(
	db: D1Database,
	ownerUserId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM community_listings
			WHERE owner_user_id = ? AND status = 'active'`,
		)
		.bind(ownerUserId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

const publicPackageSearchColumns = [
	'name',
	'kody_id',
	'description',
	'tags_json',
] as const

export async function listPublicProfilePackages(
	db: D1Database,
	input: {
		ownerStableUserId: string
		query?: string
		limit: number
	},
): Promise<Array<PublicProfilePackage>> {
	const conditions = ['user_id = ?', 'is_private = 0', 'hidden = 0']
	const bindings: Array<unknown> = [input.ownerStableUserId]
	const tokens = extractCommunityListingLikeTokens(input.query ?? '')
	if (tokens.length > 0) {
		const tokenClauses = tokens.map((token) => {
			const pattern = `%${token}%`
			const columnClauses = publicPackageSearchColumns.map((column) => {
				bindings.push(pattern)
				return `${column} LIKE ?`
			})
			return `(${columnClauses.join(' OR ')})`
		})
		conditions.push(`(${tokenClauses.join(' OR ')})`)
	}

	const rows = await db
		.prepare(
			`SELECT id, name, kody_id, description, tags_json, updated_at
			FROM saved_packages
			WHERE ${conditions.join(' AND ')}
			ORDER BY updated_at DESC
			LIMIT ?`,
		)
		.bind(...bindings, input.limit)
		.all<Record<string, unknown>>()

	const packages = (rows.results ?? []).map((row) => ({
		packageId: String(row['id']),
		name: String(row['name']),
		kodyId: String(row['kody_id']),
		description: String(row['description']),
		tags: parseTagsJson(row['tags_json']),
		updatedAt: String(row['updated_at']),
		communityListingId: null as string | null,
	}))

	if (packages.length === 0) return packages

	const packageIds = packages.map((pkg) => pkg.packageId)
	const listingByPackageId = new Map<string, string>()
	for (const idChunk of chunkArray(packageIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const listingRows = await db
			.prepare(
				`SELECT id, package_id
				FROM community_listings
				WHERE owner_user_id = ?
					AND status = 'active'
					AND package_id IN (${placeholders})`,
			)
			.bind(input.ownerStableUserId, ...idChunk)
			.all<{ id: string; package_id: string }>()
		for (const listingRow of listingRows.results ?? []) {
			listingByPackageId.set(listingRow.package_id, listingRow.id)
		}
	}

	return packages.map((pkg) => ({
		...pkg,
		communityListingId: listingByPackageId.get(pkg.packageId) ?? null,
	}))
}
