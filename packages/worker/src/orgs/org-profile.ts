import {
	normalizeUsername,
	orgSlugPermanentError,
} from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import { getOrgById } from './repo.ts'

export type UpdateOrgProfileInput = {
	orgId: string
	displayName?: string
	slug?: string
}

export type UpdateOrgProfileResult =
	| { ok: true; slug: string; displayName: string | null }
	| {
			ok: false
			error: string
			code: 'not_found' | 'personal' | 'validation'
	  }

/**
 * Update a team organization's display name. Handles (slugs) are permanent:
 * a request that names a different slug is rejected. Signup (personal) orgs keep
 * the person's profile as their name, photo, and handle — edit those on
 * Account instead.
 */
export async function updateOrgProfile(
	db: D1Database,
	input: UpdateOrgProfileInput,
): Promise<UpdateOrgProfileResult> {
	const existing = await getOrgById(db, input.orgId)
	if (!existing) {
		return {
			ok: false,
			error: 'Organization was not found.',
			code: 'not_found',
		}
	}
	if (await isPersonalOrg(db, input.orgId)) {
		return {
			ok: false,
			error: 'Your personal organization identity is your account profile.',
			code: 'personal',
		}
	}

	const nextDisplayName =
		input.displayName === undefined
			? existing.display_name
			: input.displayName.trim()
	if (
		input.displayName !== undefined &&
		(!nextDisplayName || nextDisplayName.length > 80)
	) {
		return {
			ok: false,
			error: 'Enter a name up to 80 characters.',
			code: 'validation',
		}
	}

	if (
		input.slug !== undefined &&
		normalizeUsername(input.slug) !== existing.slug
	) {
		return { ok: false, error: orgSlugPermanentError, code: 'validation' }
	}

	const now = new Date().toISOString()
	await db
		.prepare(
			`UPDATE orgs
			 SET display_name = ?, updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(nextDisplayName, now, input.orgId)
		.run()

	return {
		ok: true,
		slug: existing.slug,
		displayName: nextDisplayName,
	}
}
