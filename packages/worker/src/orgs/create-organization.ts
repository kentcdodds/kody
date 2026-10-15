import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import {
	createOrg,
	OrgSlugValidationError,
} from '#worker/orgs/access-writes.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { orgHandleTakenError } from '#worker/orgs/org-handle-claim.ts'

export type CreateOrganizationInput = {
	audit: OrgAuditWriter
	personId: string
	slug: string
	displayName: string
}

export type CreateOrganizationResult =
	| { ok: true; slug: string }
	| { ok: false; error: string }

/**
 * Map createOrg slug errors for the web form. Reserved and taken messages are
 * already the same copy username signup / MCP use — pass them through. Format
 * failures get handle-oriented wording (the field label is Handle).
 */
function slugValidationMessage(message: string) {
	if (message.toLowerCase().includes('reserved')) return message
	if (message.toLowerCase().includes('taken')) return orgHandleTakenError
	return 'Use 3 to 32 letters, numbers, and hyphens. Start and end with a letter or number.'
}

/**
 * Web-facing create organization. Validates the display name, then calls the
 * same {@link createOrg} path MCP `orgCreate` uses (slug format, reserved
 * names, shared-namespace collision, the free-org ownership cap).
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
		if (field) return { ok: false, error: orgHandleTakenError }
		throw error
	}
}
