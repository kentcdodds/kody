import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/** Stripe object metadata keys for org-scoped billing (P6). */

export const KODY_ORG_ID_METADATA_KEY = 'kody_org_id'

/** Legacy personal-org key; same id as org for migrated rows. */
export const KODY_STABLE_USER_ID_METADATA_KEY = 'kody_stable_user_id'

/**
 * Metadata for new Stripe objects during personal-org dual-resolve. Always sets
 * `kody_org_id`; also sets `kody_stable_user_id` to the same value so webhooks
 * and checkout paths that still read the legacy key keep working. Cleanup will
 * drop `kody_stable_user_id` once all readers prefer `kody_org_id`.
 */
export function buildOrgBillingMetadata(orgId: string): Record<string, string> {
	return {
		[KODY_ORG_ID_METADATA_KEY]: orgId,
		[KODY_STABLE_USER_ID_METADATA_KEY]: orgId,
	}
}

export function resolveOrgIdFromStripeMetadata(
	metadata: Record<string, string> | null | undefined,
): OwnerId | null {
	const orgId = metadata?.[KODY_ORG_ID_METADATA_KEY]?.trim()
	if (orgId) {
		return orgId as OwnerId
	}
	const stableUserId = metadata?.[KODY_STABLE_USER_ID_METADATA_KEY]?.trim()
	return stableUserId ? (stableUserId as OwnerId) : null
}
