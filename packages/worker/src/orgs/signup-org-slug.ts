import { getOrgById } from '#worker/orgs/repo.ts'

/** Slug of the signup organization, whose id is the person's stable user id. */
export async function readSignupOrgSlug(db: D1Database, ownerId: string) {
	const org = await getOrgById(db, ownerId)
	const slug = org?.slug?.trim() ?? ''
	if (!slug) {
		throw new Error(`Signup organization is missing for ${ownerId}.`)
	}
	return slug
}

/**
 * Prefer an already-known slug. Lookup failures stay local so best-effort
 * fan-out can skip the link instead of failing the caller.
 */
export async function readSignupOrgSlugOrNull(
	db: D1Database,
	ownerId: string,
	orgSlug?: string,
) {
	const provided = orgSlug?.trim()
	if (provided) return provided
	try {
		return await readSignupOrgSlug(db, ownerId)
	} catch (error) {
		console.warn('signup organization slug lookup failed', { error })
		return null
	}
}
