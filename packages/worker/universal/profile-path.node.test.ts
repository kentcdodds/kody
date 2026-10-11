import { expect, test } from 'vitest'
import {
	getProfileUsernameFromPathname,
	isProfilePathname,
} from './profile-path.ts'

test('profile paths are /@username only, not package URLs', () => {
	expect(isProfilePathname('/@jane')).toBe(true)
	expect(getProfileUsernameFromPathname('/@jane')).toBe('jane')

	expect(isProfilePathname('/@jane/-/packages')).toBe(true)
	expect(getProfileUsernameFromPathname('/@jane/-/packages')).toBe('jane')
	expect(isProfilePathname('/@jane/helper')).toBe(false)
	expect(getProfileUsernameFromPathname('/@jane/helper')).toBeNull()
	expect(isProfilePathname('/@jane/helper/settings')).toBe(false)
	expect(isProfilePathname('/community')).toBe(false)
	expect(isProfilePathname('/account')).toBe(false)
})

test('org package list paths use the shared handle shape', () => {
	const max = 'a'.repeat(32)
	const tooLong = 'a'.repeat(33)
	expect(getProfileUsernameFromPathname(`/@${max}/-/packages`)).toBe(max)
	expect(getProfileUsernameFromPathname(`/@${max}/-/packages/`)).toBe(max)
	expect(getProfileUsernameFromPathname(`/@${tooLong}/-/packages`)).toBeNull()
	expect(getProfileUsernameFromPathname('/@ab/-/packages')).toBeNull()
	expect(getProfileUsernameFromPathname('/@abc/-/packages')).toBe('abc')
	expect(getProfileUsernameFromPathname('/@a-b/-/packages')).toBe('a-b')
	expect(getProfileUsernameFromPathname('/@-ab/-/packages')).toBeNull()
	expect(getProfileUsernameFromPathname('/@ab-/-/packages')).toBeNull()
	expect(getProfileUsernameFromPathname('/@Ab1/-/packages')).toBeNull()
})
