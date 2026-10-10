import { getUniqueConstraintField } from '#worker/database-errors.ts'
import {
	getEffectiveUsernameValidationError,
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
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
			code: 'not_found' | 'personal' | 'validation' | 'conflict'
	  }

function slugValidationMessage(message: string) {
	if (message.toLowerCase().includes('reserved')) {
		return 'This name is reserved.'
	}
	if (message.toLowerCase().includes('taken')) {
		return 'That name is taken.'
	}
	return 'Use 3 to 32 letters, numbers, and hyphens. Start and end with a letter or number.'
}

/**
 * Signup organizations use the founding person's stable id as the org id
 * (`org_id = user_id` on the founding membership). That identity survives
 * soft-deleting the founding row — include deleted memberships so another
 * owner cannot rename or soft-delete a signup org from org settings.
 */
export async function isPersonalOrg(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok
			 FROM org_memberships
			 WHERE org_id = ?
			   AND user_id = ?`,
		)
		.bind(orgId, orgId)
		.first<{ ok: number }>()
	return Boolean(row)
}

/**
 * Update a team organization's public identity. Signup (personal) orgs keep
 * the person's profile as their name, photo, and handle — edit those on
 * Account instead.
 */
export async function updateOrgProfile(
	db: D1Database,
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV'> | undefined,
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

	let nextSlug = existing.slug
	if (input.slug !== undefined) {
		const slug = normalizeUsername(input.slug)
		const formatError = getUsernameFormatValidationError(slug)
		if (formatError) {
			return {
				ok: false,
				error: slugValidationMessage(formatError),
				code: 'validation',
			}
		}
		const reservedError = await getEffectiveUsernameValidationError(slug, env)
		if (reservedError) {
			return {
				ok: false,
				error: slugValidationMessage(reservedError),
				code: 'validation',
			}
		}
		if (slug !== existing.slug) {
			const taken = await db
				.prepare(`SELECT handle FROM handles WHERE handle = ?`)
				.bind(slug)
				.first<{ handle: string }>()
			if (taken) {
				return { ok: false, error: 'That name is taken.', code: 'conflict' }
			}
		}
		nextSlug = slug
	}

	const now = new Date().toISOString()
	try {
		if (nextSlug === existing.slug) {
			await db
				.prepare(
					`UPDATE orgs
					 SET display_name = ?, updated_at = ?
					 WHERE id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(nextDisplayName, now, input.orgId)
				.run()
		} else {
			const handleRow = await db
				.prepare(`SELECT handle FROM handles WHERE org_id = ? AND handle = ?`)
				.bind(input.orgId, existing.slug)
				.first<{ handle: string }>()
			if (!handleRow) {
				return {
					ok: false,
					error: 'Unable to rename that organization handle.',
					code: 'validation',
				}
			}
			await db.batch([
				db
					.prepare(
						`UPDATE orgs
						 SET slug = ?, display_name = ?, updated_at = ?
						 WHERE id = ?${andLiveDeletedAtSql()}`,
					)
					.bind(nextSlug, nextDisplayName, now, input.orgId),
				db
					.prepare(
						`UPDATE handles
						 SET handle = ?
						 WHERE org_id = ? AND handle = ?`,
					)
					.bind(nextSlug, input.orgId, existing.slug),
			])
		}
	} catch (error) {
		const field = getUniqueConstraintField(error)
		if (field) {
			return { ok: false, error: 'That name is taken.', code: 'conflict' }
		}
		throw error
	}

	return {
		ok: true,
		slug: nextSlug,
		displayName: nextDisplayName,
	}
}
