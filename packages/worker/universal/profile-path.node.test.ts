import { expect, test } from 'vitest'
import {
	getProfileUsernameFromPathname,
	isProfilePathname,
} from './profile-path.ts'

test('profile paths are /@username only, not package URLs', () => {
	expect(isProfilePathname('/@jane')).toBe(true)
	expect(getProfileUsernameFromPathname('/@jane')).toBe('jane')

	expect(isProfilePathname('/@jane/helper')).toBe(false)
	expect(getProfileUsernameFromPathname('/@jane/helper')).toBeNull()
	expect(isProfilePathname('/@jane/helper/settings')).toBe(false)
	expect(isProfilePathname('/community')).toBe(false)
	expect(isProfilePathname('/account')).toBe(false)
})
