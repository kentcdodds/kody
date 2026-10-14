import {
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	personalOrgIdForPerson,
	personalOrgIdFromUserRow,
} from './personal-org-id.ts'

const personId = 'a'.repeat(64)
const distinctOrgId = 'b'.repeat(64)

test('personalOrgIdFromUserRow prefers a stored personal org id', () => {
	expect(
		personalOrgIdFromUserRow({
			personal_org_id: distinctOrgId,
			stable_user_id: personId,
		}),
	).toBe(distinctOrgId)
	expect(
		personalOrgIdFromUserRow({
			personal_org_id: `  ${distinctOrgId}  `,
			stable_user_id: personId,
		}),
	).toBe(distinctOrgId)
})

test('personalOrgIdFromUserRow falls back to the person id while the column is empty', () => {
	const expected = personalOrgId(personIdFromStored(personId))
	for (const personalOrgIdValue of [null, undefined, '', '   ']) {
		expect(
			personalOrgIdFromUserRow({
				personal_org_id: personalOrgIdValue,
				stable_user_id: `  ${personId}  `,
			}),
		).toBe(expected)
	}
	expect(expected).toBe(personId)
})

test('personalOrgIdForPerson prefers a stamped personalOrgId', () => {
	const userId = personIdFromStored(personId)
	expect(
		personalOrgIdForPerson({
			userId,
			personalOrgId: distinctOrgId as never,
		}),
	).toBe(distinctOrgId)
	expect(personalOrgIdForPerson({ userId })).toBe(personalOrgId(userId))
})
