import { expect, test } from 'vitest'
import {
	mintPersonId,
	personalOrgId,
	ownerIdFromStored,
	parseOwnerId,
	parsePersonId,
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from './owner-person-ids.ts'

const stableId = 'a'.repeat(64)

test('parsers accept only trimmed 64-hex stable ids', () => {
	expect(parsePersonId(` ${stableId} `)).toBe(stableId)
	expect(parseOwnerId(stableId)).toBe(stableId)
	for (const invalid of [
		'',
		'A'.repeat(64),
		'a'.repeat(63),
		'user-1',
		null,
		undefined,
		42,
	]) {
		expect(parsePersonId(invalid)).toBeNull()
		expect(parseOwnerId(invalid)).toBeNull()
	}
})

test('stored ids are trimmed and must be non-empty', () => {
	expect(personIdFromStored(` ${stableId}`)).toBe(stableId)
	expect(ownerIdFromStored('system:email')).toBe('system:email')
	expect(() => personIdFromStored('  ')).toThrow('Person id is required')
	expect(() => ownerIdFromStored(null)).toThrow('Owner id is required')
})

test('new people get random 64-hex ids', () => {
	const first = mintPersonId()
	expect(first).toMatch(/^[a-f0-9]{64}$/)
	expect(mintPersonId()).not.toBe(first)
})

test("a person's personal org reuses their stable id", () => {
	const person = personIdFromStored(stableId)
	expect(personalOrgId(person)).toBe(stableId)
})

test('owner and person ids cannot be mixed without personalOrgId', () => {
	const person = personIdFromStored(stableId)
	const owner = personalOrgId(person)
	const takesOwner = (value: OwnerId) => value
	const takesPerson = (value: PersonId) => value

	// @ts-expect-error a PersonId is not an OwnerId
	takesOwner(person)
	// @ts-expect-error an OwnerId is not a PersonId
	takesPerson(owner)
	// @ts-expect-error a plain string is not an OwnerId
	takesOwner(stableId)
	// @ts-expect-error re-branding a PersonId as an owner must go through personalOrgId
	ownerIdFromStored(person)
	// @ts-expect-error re-branding an OwnerId as a person is never allowed
	personIdFromStored(owner)
	// @ts-expect-error parsing cannot launder a PersonId into an OwnerId
	parseOwnerId(person)
	// @ts-expect-error parsing cannot launder an OwnerId into a PersonId
	parsePersonId(owner)

	const asString: string = owner
	expect(asString).toBe(stableId)
})
