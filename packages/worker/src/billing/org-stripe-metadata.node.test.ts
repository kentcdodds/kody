import { expect, test } from 'vitest'
import {
	buildOrgBillingMetadata,
	KODY_ORG_ID_METADATA_KEY,
	KODY_STABLE_USER_ID_METADATA_KEY,
	resolveOrgIdFromStripeMetadata,
} from './org-stripe-metadata.ts'

test('buildOrgBillingMetadata dual-writes the same org id on both keys', () => {
	expect(buildOrgBillingMetadata('org-acme')).toEqual({
		[KODY_ORG_ID_METADATA_KEY]: 'org-acme',
		[KODY_STABLE_USER_ID_METADATA_KEY]: 'org-acme',
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
