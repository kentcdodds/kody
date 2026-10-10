import {
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { entitlementEmailForOwner } from './owner-id.ts'

test('entitlement email pairs only with the caller personal org', () => {
	const userId = personIdFromStored('11111111-1111-4111-8111-111111111111')
	const caller = { user: { userId, email: 'alice@example.com' } }
	expect(entitlementEmailForOwner(caller, personalOrgId(userId))).toBe(
		'alice@example.com',
	)
	const teamOrg = ownerIdFromStored('22222222-2222-4222-8222-222222222222')
	expect(entitlementEmailForOwner(caller, teamOrg)).toBeNull()
	expect(entitlementEmailForOwner({ user: null }, teamOrg)).toBeNull()
})
