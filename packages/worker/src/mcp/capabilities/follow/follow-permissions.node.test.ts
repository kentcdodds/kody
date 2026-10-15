import { expect, test } from 'vitest'
import { followAddCapability } from './follow-add.ts'
import { followListCapability } from './follow-list.ts'
import { followRemoveCapability } from './follow-remove.ts'

test('follow add, list, and remove require org:read', () => {
	expect(followAddCapability.orgPermission).toBe('org:read')
	expect(followListCapability.orgPermission).toBe('org:read')
	expect(followRemoveCapability.orgPermission).toBe('org:read')
})
