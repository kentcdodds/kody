import { expect, test } from 'vitest'
import {
	getProfileUsernameFromPathname,
	isProfilePathname,
} from './profile-path.ts'

test('profile paths are /@username only, not package URLs', () => {
	expect(isProfilePathname('/@jane')).toBe(true)
	expect(getProfileUsernameFromPathname('/@jane')).toBe('jane')

	expect(isProfilePathname('/@jane/-/repositories')).toBe(true)
	expect(getProfileUsernameFromPathname('/@jane/-/repositories')).toBe('jane')
	expect(isProfilePathname('/@jane/helper')).toBe(false)
	expect(getProfileUsernameFromPathname('/@jane/helper')).toBeNull()
	expect(isProfilePathname('/@jane/helper/settings')).toBe(false)
	expect(isProfilePathname('/community')).toBe(false)
	expect(isProfilePathname('/account')).toBe(false)
})

test('org package list paths use the shared handle shape', () => {
	const max = 'a'.repeat(32)
	const tooLong = 'a'.repeat(33)
	expect(getProfileUsernameFromPathname(`/@${max}/-/repositories`)).toBe(max)
	expect(getProfileUsernameFromPathname(`/@${max}/-/repositories/`)).toBe(max)
	expect(
		getProfileUsernameFromPathname(`/@${tooLong}/-/repositories`),
	).toBeNull()
	expect(getProfileUsernameFromPathname('/@ab/-/repositories')).toBeNull()
	expect(getProfileUsernameFromPathname('/@abc/-/repositories')).toBe('abc')
	expect(getProfileUsernameFromPathname('/@a-b/-/repositories')).toBe('a-b')
	expect(getProfileUsernameFromPathname('/@-ab/-/repositories')).toBeNull()
	expect(getProfileUsernameFromPathname('/@ab-/-/repositories')).toBeNull()
	expect(getProfileUsernameFromPathname('/@Ab1/-/repositories')).toBeNull()
})
