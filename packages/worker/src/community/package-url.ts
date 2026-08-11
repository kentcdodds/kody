import { routes } from '#universal/routes.ts'
import { findPublicUserIdentityByUsername } from '#worker/identity/user-lookup.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { kodyPackageIdPattern } from '#worker/package-registry/types.ts'
import { getCommunityListingByOwnerAndKodyId } from './repo.ts'

/**
 * Canonical public URL of a published package: `/@owner/kody-id`. Both halves
 * are renameable, so a URL that no longer resolves directly is followed through
 * the retirement tables below before it is treated as missing.
 */
export function getCommunityPackageHref(input: {
	username: string
	kodyId: string
}) {
	return routes.communityPackage.href({
		username: input.username,
		kodyId: input.kodyId,
	})
}

export type CommunityPackageUrlTarget =
	| { kind: 'listing'; listingId: string; username: string; kodyId: string }
	// The requested pair is retired (or not canonically spelled); `username` and
	// `kodyId` are the pair that owns the package now, and `listingId` is the
	// listing that pair resolves to — a caller redirecting *to* the canonical URL
	// can check it lands on the listing it started from.
	| { kind: 'redirect'; listingId: string; username: string; kodyId: string }

// A rename chain collapses in one hop because retirement rows point at the
// package, not at the next name in the chain. Username hops can still stack (a
// user renaming twice retires two names), so allow a few and stop rather than
// following a cycle forever.
const maxUsernameRedirectHops = 4

function normalizeKodyId(value: string) {
	return value.trim().toLowerCase()
}

/**
 * Resolve `/@username/kodyId` to the listing it addresses, or to the canonical
 * pair a moved package now lives at. Returns null when nothing owns the pair,
 * which the caller renders as a 404 — never as a redirect, so a retired pair
 * cannot be used to bounce visitors at an unrelated package.
 */
export async function resolveCommunityPackageUrl(input: {
	db: D1Database
	username: string
	kodyId: string
}): Promise<CommunityPackageUrlTarget | null> {
	const requestedUsername = input.username.trim()
	const requestedKodyId = input.kodyId.trim()
	let username = normalizeUsername(requestedUsername)
	const kodyId = normalizeKodyId(requestedKodyId)
	if (!username || !kodyPackageIdPattern.test(kodyId)) return null

	// A pair that differs only in spelling still moves the visitor, so the
	// canonical form is served from one URL instead of several.
	let moved = username !== requestedUsername || kodyId !== requestedKodyId

	for (let hop = 0; hop <= maxUsernameRedirectHops; hop++) {
		const identity = await findPublicUserIdentityByUsername({
			db: input.db,
			username,
		})
		if (identity) {
			const listing = await getCommunityListingByOwnerAndKodyId(input.db, {
				ownerUserId: identity.mcpUserId,
				kodyId,
			})
			if (listing) {
				return moved
					? {
							kind: 'redirect',
							listingId: listing.id,
							username: identity.username,
							kodyId,
						}
					: {
							kind: 'listing',
							listingId: listing.id,
							username: identity.username,
							kodyId,
						}
			}
			const currentKodyId = await findCurrentKodyIdForRetiredKodyId({
				db: input.db,
				userId: identity.mcpUserId,
				oldKodyId: kodyId,
			})
			if (currentKodyId == null || currentKodyId === kodyId) return null
			// The package still exists under a new id; only send visitors there
			// when that pair actually has a listing.
			const currentListing = await getCommunityListingByOwnerAndKodyId(
				input.db,
				{ ownerUserId: identity.mcpUserId, kodyId: currentKodyId },
			)
			if (!currentListing) return null
			return {
				kind: 'redirect',
				listingId: currentListing.id,
				username: identity.username,
				kodyId: currentKodyId,
			}
		}

		// No live user owns the username. A retired one resolves to whoever holds
		// it now; a live `users.username` always wins, so reclaiming a released
		// username cannot be hijacked by the previous holder's retirement row.
		const currentUsername = await findCurrentUsernameForRetiredUsername({
			db: input.db,
			oldUsername: username,
		})
		if (currentUsername == null || currentUsername === username) return null
		username = currentUsername
		moved = true
	}
	return null
}

async function findCurrentUsernameForRetiredUsername(input: {
	db: D1Database
	oldUsername: string
}): Promise<string | null> {
	const row = await input.db
		.prepare(
			`SELECT users.username AS username
			FROM username_redirects
			JOIN users ON users.stable_user_id = username_redirects.user_id
			WHERE username_redirects.old_username = ?`,
		)
		.bind(input.oldUsername)
		.first<{ username: string | null }>()
	const username = row?.username?.trim()
	return username ? username : null
}

async function findCurrentKodyIdForRetiredKodyId(input: {
	db: D1Database
	userId: string
	oldKodyId: string
}): Promise<string | null> {
	const row = await input.db
		.prepare(
			`SELECT saved_packages.kody_id AS kody_id
			FROM package_kody_id_redirects
			JOIN saved_packages
				ON saved_packages.id = package_kody_id_redirects.package_id
				AND saved_packages.user_id = package_kody_id_redirects.user_id
			WHERE package_kody_id_redirects.user_id = ?
				AND package_kody_id_redirects.old_kody_id = ?`,
		)
		.bind(input.userId, input.oldKodyId)
		.first<{ kody_id: string | null }>()
	const kodyId = row?.kody_id?.trim()
	return kodyId ? kodyId : null
}

/**
 * Retire the username a user just changed away from. Claiming a username also
 * clears any retirement row for it: the claim is authoritative, and a stale row
 * would otherwise outlive the name it points away from.
 */
export async function retireUsername(input: {
	db: D1Database
	oldUsername: string
	newUsername: string
	userId: string
}) {
	const oldUsername = normalizeUsername(input.oldUsername)
	const newUsername = normalizeUsername(input.newUsername)
	if (!oldUsername || oldUsername === newUsername) return
	await input.db.batch([
		input.db
			.prepare(`DELETE FROM username_redirects WHERE old_username = ?`)
			.bind(newUsername),
		input.db
			.prepare(
				`INSERT INTO username_redirects (old_username, user_id)
				VALUES (?, ?)
				ON CONFLICT (old_username) DO UPDATE SET
					user_id = excluded.user_id,
					created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.bind(oldUsername, input.userId),
	])
}

/**
 * Claim an id for a package: any retirement row pointing away from it was left
 * by a package that no longer owns the name, and letting it stand would forward
 * the new package's own URL to an unrelated one.
 */
export async function releasePackageKodyIdRedirect(input: {
	db: D1Database
	userId: string
	kodyId: string
}) {
	const kodyId = normalizeKodyId(input.kodyId)
	if (!kodyId) return
	await input.db
		.prepare(
			`DELETE FROM package_kody_id_redirects
			WHERE user_id = ? AND old_kody_id = ?`,
		)
		.bind(input.userId, kodyId)
		.run()
}

/**
 * Retire the `kody.id` a package just moved away from, so links shared under
 * the old id follow the package to its new one.
 */
export async function retirePackageKodyId(input: {
	db: D1Database
	userId: string
	packageId: string
	oldKodyId: string
	newKodyId: string
}) {
	const oldKodyId = normalizeKodyId(input.oldKodyId)
	const newKodyId = normalizeKodyId(input.newKodyId)
	if (!oldKodyId || oldKodyId === newKodyId) return
	await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM package_kody_id_redirects
				WHERE user_id = ? AND old_kody_id = ?`,
			)
			.bind(input.userId, newKodyId),
		input.db
			.prepare(
				`INSERT INTO package_kody_id_redirects (user_id, old_kody_id, package_id)
				VALUES (?, ?, ?)
				ON CONFLICT (user_id, old_kody_id) DO UPDATE SET
					package_id = excluded.package_id,
					created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.bind(input.userId, oldKodyId, input.packageId),
	])
}

/**
 * Deleting a package releases every id it retired: the ids no longer lead
 * anywhere, and keeping them would let a later package inherit another
 * package's redirect history.
 */
export async function deletePackageKodyIdRedirects(input: {
	db: D1Database
	userId: string
	packageId: string
}) {
	await input.db
		.prepare(
			`DELETE FROM package_kody_id_redirects
			WHERE user_id = ? AND package_id = ?`,
		)
		.bind(input.userId, input.packageId)
		.run()
}
