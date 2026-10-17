/**
 * Shared claim checks for organization handles (team-org slugs). Users and
 * orgs share the `@` namespace, so org create uses the same reserved/format
 * rules as usernames plus the identity collision helper.
 */
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'

/** Same reserved copy the username signup form surfaces. */
export const orgHandleReservedError = 'This username is reserved.'

/** Web create-org wording when the handle is already claimed in the namespace. */
export const orgHandleTakenError = 'That name is taken.'

/** Web create-org wording when this person can restore the soft-deleted org. */
export function orgHandleRestorableError(slug: string) {
	return `You deleted @${slug}. Restore it instead of creating a new organization.`
}

/**
 * Validate a candidate org handle before insert. Returns a user-facing error
 * or null when the handle is claimable. Callers must still treat UNIQUE on
 * `handles` / `orgs.slug` as a race fallback.
 */
export async function getOrgHandleClaimError(
	slug: string,
	db: D1Database,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	const normalized = normalizeUsername(slug)
	const reservedOrFormat = await getEffectiveUsernameValidationError(
		normalized,
		env,
	)
	if (reservedOrFormat) return reservedOrFormat
	if (await isUsernameClaimedInIdentity(db, normalized)) {
		return orgHandleTakenError
	}
	return null
}
