import {
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { entitlementEmailForOwner, ownerIdFromCaller } from './owner-id.ts'

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

test('usage metering keys off the request org, including team orgs', () => {
	const userId = personIdFromStored('11111111-1111-4111-8111-111111111111')
	const teamOrg = ownerIdFromStored('22222222-2222-4222-8222-222222222222')
	expect(
		ownerIdFromCaller({
			request: { org: { id: teamOrg } },
			user: { userId },
		}),
	).toBe(teamOrg)
	expect(ownerIdFromCaller({ user: { userId } })).toBe(personalOrgId(userId))
})

test('ownerIdFromCaller and entitlement email prefer stamped personalOrgId', () => {
	const userId = personIdFromStored('a'.repeat(64))
	const distinctOrg = ownerIdFromStored('b'.repeat(64))
	const caller = {
		user: {
			userId,
			email: 'ada@example.com',
			personalOrgId: distinctOrg,
		},
	}
	expect(ownerIdFromCaller(caller)).toBe(distinctOrg)
	expect(entitlementEmailForOwner(caller, distinctOrg)).toBe('ada@example.com')
	expect(entitlementEmailForOwner(caller, personalOrgId(userId))).toBeNull()
})
