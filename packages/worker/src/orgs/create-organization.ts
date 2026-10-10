import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import {
	createOrg,
	OrgSlugValidationError,
} from '#worker/orgs/access-writes.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'

export type CreateOrganizationInput = {
	audit: OrgAuditWriter
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

/**
 * Web-facing create organization. Validates the display name, then calls the
 * same {@link createOrg} path MCP `orgCreate` uses (slug format and reserved
 * names, the free-org ownership cap).
 */
export async function createOrganization(
	db: D1Database,
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
	input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
	const slug = normalizeUsername(input.slug)
	const displayName = input.displayName.trim()
	if (!displayName || displayName.length > 80) {
		return { ok: false, error: 'Enter a name up to 80 characters.' }
	}
	const taken = await db
		.prepare(`SELECT handle FROM handles WHERE handle = ?`)
		.bind(slug)
		.first<{ handle: string }>()
	if (taken) return { ok: false, error: 'That name is taken.' }

	try {
		const created = await createOrg({
			db,
			env,
			slug,
			displayName,
			createdByUserId: input.personId,
			audit: input.audit,
		})
		return { ok: true, slug: created.slug }
	} catch (error) {
		if (error instanceof OrgSlugValidationError) {
			return { ok: false, error: slugValidationMessage(error.message) }
		}
		if (error instanceof FreeOrgLimitError) {
			return { ok: false, error: error.message }
		}
		const field = getUniqueConstraintField(error)
		if (field) return { ok: false, error: 'That name is taken.' }
		throw error
	}
}
