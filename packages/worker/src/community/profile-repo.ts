import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { parseTagsJson } from '@kody-internal/shared/tags-json.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'
import { extractCommunityListingLikeTokens } from './repo.ts'
import {
	type CommunityActivityEventType,
	type CommunityActivityItem,
	type ProfileVisibility,
	type PublicProfilePackage,
} from './types.ts'

// D1 caps bound parameters per statement; 90 leaves headroom for fixed binds.
const maxSqlBindingsPerChunk = 90

export type UserSocialRow = {
	id: number
	username: string
	email: string
	stable_user_id: string
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
		stable_user_id: String(row['stable_user_id']),
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
	const trimmed = normalizeStableUserId(stableUserId)
	if (!trimmed) return null
	const row = await db
		.prepare(
			`SELECT ${userSocialSelectColumns}
			FROM users
			WHERE stable_user_id = ?`,
		)
		.bind(trimmed)
		.first<Record<string, unknown>>()
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

			const [storedRows, forkRows] = await Promise.all([
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
			return items
		}),
	)

	const items = chunkResults.flat()
	items.sort(compareActivityItems)
	return items.slice(0, input.limit)
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
		/** When true, include private and hidden packages (own-profile inventory). */
		includePrivate?: boolean
	},
): Promise<Array<PublicProfilePackage>> {
	const conditions = input.includePrivate
		? ['user_id = ?']
		: ['user_id = ?', 'is_private = 0', 'hidden = 0']
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
			`SELECT id, name, kody_id, description, tags_json, updated_at,
				is_private, hidden
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
		communityListingKodyId: null as string | null,
		communityPublishedAt: null as string | null,
		isPrivate: Number(row['is_private']) === 1,
		hidden: Number(row['hidden']) === 1,
	}))

	if (packages.length === 0) return packages

	const packageIds = packages.map((pkg) => pkg.packageId)
	// The listing's own `kody_id` travels with its id: it only moves on republish,
	// so it is the id the public URL actually resolves under.
	const listingByPackageId = new Map<
		string,
		{ id: string; kodyId: string | null; publishedAt: string }
	>()
	for (const idChunk of chunkArray(packageIds, maxSqlBindingsPerChunk)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const listingRows = await db
			.prepare(
				`SELECT id, package_id, kody_id, published_at
				FROM community_listings
				WHERE owner_user_id = ?
					AND status = 'active'
					AND package_id IN (${placeholders})`,
			)
			.bind(input.ownerStableUserId, ...idChunk)
			.all<{
				id: string
				package_id: string
				kody_id: string | null
				published_at: string
			}>()
		for (const listingRow of listingRows.results ?? []) {
			listingByPackageId.set(listingRow.package_id, {
				id: listingRow.id,
				kodyId: listingRow.kody_id,
				publishedAt: String(listingRow.published_at),
			})
		}
	}

	return packages.map((pkg) => {
		const listing = listingByPackageId.get(pkg.packageId)
		return {
			...pkg,
			communityListingId: listing?.id ?? null,
			communityListingKodyId: listing?.kodyId ?? null,
			communityPublishedAt: listing?.publishedAt ?? null,
		}
	})
}
