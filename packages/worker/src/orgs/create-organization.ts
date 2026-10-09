import {
	mintPersonId,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'

export type CreateOrganizationInput = {
	personId: string
	slug: string
	displayName: string
}

export type CreateOrganizationResult =
	| { ok: true; slug: string }
	| { ok: false; error: string }

function slugValidationMessage(message: string) {
	if (message.toLowerCase().includes('reserved'))
		return 'This name is reserved.'
	if (message.toLowerCase().includes('taken')) return 'That name is taken.'
	return 'Use 3 to 32 letters, numbers, and hyphens. Start and end with a letter or number.'
}

export async function createOrganization(
	db: D1Database,
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
	input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
	const slug = normalizeUsername(input.slug)
	const validationError = await getEffectiveUsernameValidationError(slug, env)
	if (validationError) {
		return { ok: false, error: slugValidationMessage(validationError) }
	}
	const displayName = input.displayName.trim()
	if (!displayName || displayName.length > 80) {
		return { ok: false, error: 'Enter a name up to 80 characters.' }
	}
	const taken = await db
		.prepare(`SELECT handle FROM handles WHERE handle = ?`)
		.bind(slug)
		.first<{ handle: string }>()
	if (taken) return { ok: false, error: 'That name is taken.' }

	const orgId = ownerIdFromStored(String(mintPersonId()))
	const now = new Date().toISOString()
	try {
		await db
			.prepare(
				`INSERT INTO orgs (
					id, slug, display_name, created_by_user_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(orgId, slug, displayName, input.personId, now, now)
			.run()
		await db
			.prepare(
				`INSERT INTO org_memberships (
					org_id, user_id, role, invited_by_user_id, created_at, deleted_at
				) VALUES (?, ?, 'owner', NULL, ?, NULL)`,
			)
			.bind(orgId, input.personId, now)
			.run()
		await db
			.prepare(
				`INSERT INTO handles (handle, user_id, org_id, created_at)
				 VALUES (?, NULL, ?, ?)`,
			)
			.bind(slug, orgId, now)
			.run()
	} catch (error) {
		const field = getUniqueConstraintField(error)
		if (field) return { ok: false, error: 'That name is taken.' }
		throw error
	}
	return { ok: true, slug }
}
