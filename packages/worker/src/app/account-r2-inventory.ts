import { accountUserOwnedR2Surfaces } from '#app/account-user-owned-surfaces.ts'
import { buildCommunityIconR2Key } from '#worker/community/community-icon.ts'
import { emailRawMimeKey } from '#worker/email/repo.ts'

export type AccountR2Binding = 'EMAIL_BLOBS' | 'COMMUNITY_ASSETS'

export type AccountR2ObjectRef = {
	surfaceId: (typeof accountUserOwnedR2Surfaces)[number]['id']
	binding: AccountR2Binding
	key: string
}

export type AccountCommunityListingSnapshot = {
	id: string
	pinnedCommit: string
	iconCommit: string
}

function uniqueObjects(objects: ReadonlyArray<AccountR2ObjectRef>) {
	return Array.from(
		new Map(
			objects
				.filter((object) => object.key.trim().length > 0)
				.map((object) => [`${object.binding}:${object.key}`, object] as const),
		).values(),
	).sort(
		(left, right) =>
			left.binding.localeCompare(right.binding) ||
			left.key.localeCompare(right.key),
	)
}

function bindingFor(
	surfaceId: AccountR2ObjectRef['surfaceId'],
): AccountR2Binding {
	const surface = accountUserOwnedR2Surfaces.find(
		(candidate) => candidate.id === surfaceId,
	)
	if (!surface || surface.export !== 'chunked_bytes') {
		throw new Error(`Missing chunked R2 export disposition for ${surfaceId}.`)
	}
	return surface.binding
}

export async function collectAccountR2Inventory(input: {
	env: Env
	userId: string
	dbUserId: number
}): Promise<{
	objects: Array<AccountR2ObjectRef>
	communityListings: Array<AccountCommunityListingSnapshot>
}> {
	const [rawMimeRows, attachmentRows, listingRows, avatarRow] =
		await Promise.all([
			input.env.APP_DB.prepare(
				`SELECT id FROM email_messages WHERE user_id = ?`,
			)
				.bind(input.userId)
				.all<{ id: string }>(),
			input.env.APP_DB.prepare(
				`SELECT attachment.storage_key AS storage_key
				FROM email_attachments attachment
				JOIN email_messages message ON message.id = attachment.message_id
				WHERE message.user_id = ? AND attachment.storage_key IS NOT NULL`,
			)
				.bind(input.userId)
				.all<{ storage_key: string }>(),
			input.env.APP_DB.prepare(
				`SELECT community_listings.id, community_listings.pinned_commit,
					entity_sources.published_commit AS source_published_commit
				FROM community_listings
				LEFT JOIN entity_sources
					ON entity_sources.id = community_listings.source_id
					AND entity_sources.user_id = community_listings.owner_user_id
					AND entity_sources.entity_kind = 'package'
					AND entity_sources.entity_id = community_listings.package_id
				WHERE community_listings.owner_user_id = ?`,
			)
				.bind(input.userId)
				.all<{
					id: string
					pinned_commit: string
					source_published_commit: string | null
				}>(),
			input.env.APP_DB.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.first<{ avatar_key: string | null }>(),
		])

	const communityListings = (listingRows.results ?? []).map((row) => ({
		id: row.id,
		pinnedCommit: row.pinned_commit,
		iconCommit: row.source_published_commit ?? row.pinned_commit,
	}))
	const objects: Array<AccountR2ObjectRef> = [
		...(rawMimeRows.results ?? []).map((row) => ({
			surfaceId: 'email_raw_mime' as const,
			binding: bindingFor('email_raw_mime'),
			key: emailRawMimeKey(input.userId, row.id),
		})),
		...(attachmentRows.results ?? []).map((row) => ({
			surfaceId: 'email_attachment_storage_key' as const,
			binding: bindingFor('email_attachment_storage_key'),
			key: row.storage_key,
		})),
		...communityListings.flatMap((listing) =>
			[listing.pinnedCommit, listing.iconCommit].map((commit) => ({
				surfaceId: 'community_icon' as const,
				binding: bindingFor('community_icon'),
				key: buildCommunityIconR2Key({
					listingId: listing.id,
					commit,
				}),
			})),
		),
		...(avatarRow?.avatar_key
			? [
					{
						surfaceId: 'user_avatar' as const,
						binding: bindingFor('user_avatar'),
						key: avatarRow.avatar_key,
					},
				]
			: []),
	]
	return { objects: uniqueObjects(objects), communityListings }
}
