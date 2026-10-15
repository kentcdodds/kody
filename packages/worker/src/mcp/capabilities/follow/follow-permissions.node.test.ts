import { expect, test } from 'vitest'
import { followAddCapability } from './follow-add.ts'
import { followListCapability } from './follow-list.ts'

test('follow add and list require org:read', () => {
	expect(followAddCapability.orgPermission).toBe('org:read')
	expect(followListCapability.orgPermission).toBe('org:read')
})
