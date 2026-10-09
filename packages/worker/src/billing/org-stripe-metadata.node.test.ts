import { expect, test } from 'vitest'
import {
	buildOrgBillingMetadata,
	KODY_ORG_ID_METADATA_KEY,
	KODY_STABLE_USER_ID_METADATA_KEY,
	resolveOrgIdFromStripeMetadata,
} from './org-stripe-metadata.ts'

test('buildOrgBillingMetadata sets both org keys to the same id', () => {
	expect(buildOrgBillingMetadata('org_abc')).toEqual({
		[KODY_ORG_ID_METADATA_KEY]: 'org_abc',
		[KODY_STABLE_USER_ID_METADATA_KEY]: 'org_abc',
	})
})

test('resolveOrgIdFromStripeMetadata prefers kody_org_id', () => {
	expect(
		resolveOrgIdFromStripeMetadata({
			[KODY_ORG_ID_METADATA_KEY]: 'org-new',
			[KODY_STABLE_USER_ID_METADATA_KEY]: 'legacy-id',
		}),
	).toBe('org-new')
})

test('resolveOrgIdFromStripeMetadata falls back to kody_stable_user_id', () => {
	expect(
		resolveOrgIdFromStripeMetadata({
			[KODY_STABLE_USER_ID_METADATA_KEY]: 'stable-1',
		}),
	).toBe('stable-1')
})

test('resolveOrgIdFromStripeMetadata returns null when missing or blank', () => {
	expect(resolveOrgIdFromStripeMetadata(null)).toBeNull()
	expect(resolveOrgIdFromStripeMetadata(undefined)).toBeNull()
	expect(resolveOrgIdFromStripeMetadata({})).toBeNull()
	expect(
		resolveOrgIdFromStripeMetadata({
			[KODY_ORG_ID_METADATA_KEY]: '  ',
		}),
	).toBeNull()
})
