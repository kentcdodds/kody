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
	const seen = new Set<string>()
	const unique: Array<AccountR2ObjectRef> = []
	for (const object of objects) {
		const identity = `${object.binding}:${object.key}`
		if (!object.key.trim() || seen.has(identity)) continue
		seen.add(identity)
		unique.push(object)
	}
	return unique
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

async function listUserEmailMessageIds(env: Env, userId: string) {
	const ids: Array<string> = []
	let afterRowid = 0
	const pageSize = 500
	while (true) {
		const rows = await env.APP_DB.prepare(
			`SELECT rowid AS account_r2_rowid, id
			FROM email_messages
			WHERE user_id = ? AND rowid > ?
			ORDER BY rowid
			LIMIT ?`,
		)
			.bind(userId, afterRowid, pageSize + 1)
			.all<{ account_r2_rowid: number; id: string }>()
		const page = rows.results ?? []
		const truncated = page.length > pageSize
		const included = truncated ? page.slice(0, pageSize) : page
		ids.push(...included.map((row) => row.id))
		if (!truncated) return ids
		afterRowid = included.at(-1)?.account_r2_rowid ?? afterRowid
	}
}

async function listUserAttachmentKeys(env: Env, userId: string) {
	const keys: Array<string> = []
	let afterRowid = 0
	const pageSize = 500
	while (true) {
		const rows = await env.APP_DB.prepare(
			`SELECT attachment.rowid AS account_r2_rowid,
				attachment.storage_key
			FROM email_attachments AS attachment
			JOIN email_messages AS message ON message.id = attachment.message_id
			WHERE message.user_id = ? AND attachment.storage_key IS NOT NULL
				AND attachment.rowid > ?
			ORDER BY attachment.rowid
			LIMIT ?`,
		)
			.bind(userId, afterRowid, pageSize + 1)
			.all<{ account_r2_rowid: number; storage_key: string }>()
		const page = rows.results ?? []
		const truncated = page.length > pageSize
		const included = truncated ? page.slice(0, pageSize) : page
		keys.push(...included.map((row) => row.storage_key))
		if (!truncated) return keys
		afterRowid = included.at(-1)?.account_r2_rowid ?? afterRowid
	}
}

async function listUserCommunityListings(env: Env, userId: string) {
	const listings: Array<AccountCommunityListingSnapshot> = []
	let afterRowid = 0
	const pageSize = 500
	while (true) {
		const rows = await env.APP_DB.prepare(
			`SELECT community_listings.rowid AS account_r2_rowid,
				community_listings.id, community_listings.pinned_commit,
				entity_sources.published_commit AS source_published_commit
			FROM community_listings
			LEFT JOIN entity_sources
				ON entity_sources.id = community_listings.source_id
				AND entity_sources.user_id = community_listings.owner_user_id
				AND entity_sources.entity_kind = 'package'
				AND entity_sources.entity_id = community_listings.package_id
			WHERE community_listings.owner_user_id = ?
				AND community_listings.rowid > ?
			ORDER BY community_listings.rowid
			LIMIT ?`,
		)
			.bind(userId, afterRowid, pageSize + 1)
			.all<{
				account_r2_rowid: number
				id: string
				pinned_commit: string
				source_published_commit: string | null
			}>()
		const page = rows.results ?? []
		const truncated = page.length > pageSize
		const included = truncated ? page.slice(0, pageSize) : page
		listings.push(
			...included.map((row) => ({
				id: row.id,
				pinnedCommit: row.pinned_commit,
				iconCommit: row.source_published_commit ?? row.pinned_commit,
			})),
		)
		if (!truncated) return listings
		afterRowid = included.at(-1)?.account_r2_rowid ?? afterRowid
	}
}

export async function collectAccountR2Inventory(input: {
	env: Env
	userId: string
	dbUserId: number
}): Promise<{
	objects: Array<AccountR2ObjectRef>
	communityListings: Array<AccountCommunityListingSnapshot>
}> {
	const [rawMimeRows, attachmentKeys, communityListings, avatarRow] =
		await Promise.all([
			listUserEmailMessageIds(input.env, input.userId),
			listUserAttachmentKeys(input.env, input.userId),
			listUserCommunityListings(input.env, input.userId),
			input.env.APP_DB.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.first<{ avatar_key: string | null }>(),
		])

	const objects: Array<AccountR2ObjectRef> = [
		...rawMimeRows.map((messageId) => ({
			surfaceId: 'email_raw_mime' as const,
			binding: bindingFor('email_raw_mime'),
			key: emailRawMimeKey(input.userId, messageId),
		})),
		...attachmentKeys.map((key) => ({
			surfaceId: 'email_attachment_storage_key' as const,
			binding: bindingFor('email_attachment_storage_key'),
			key,
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
