import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

test('createStableUserIdFromEmail normalizes email casing and whitespace', async () => {
	const a = await createStableUserIdFromEmail('  Me@KentCodds.com ')
	const b = await createStableUserIdFromEmail('me@kentcodds.com')

	expect(a).toBe(b)
	expect(a).toMatch(/^[a-f0-9]{64}$/)
})
