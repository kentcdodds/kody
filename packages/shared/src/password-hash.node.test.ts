import { expect, test } from 'vitest'

import { createPasswordHash, verifyPassword } from './password-hash.ts'

test('verifyPassword accepts valid hashes', async () => {
	const password = 'kodylovesyou'
	const hash = await createPasswordHash(password)

	await expect(verifyPassword(password, hash)).resolves.toBe(true)
})

test('verifyPassword rejects iteration values with trailing characters', async () => {
	const password = 'kodylovesyou'
	const hash = await createPasswordHash(password)
	const [prefix, iterations, saltHex, hashHex] = hash.split('$')
	const tamperedHash = `${prefix}$${iterations}abc$${saltHex}$${hashHex}`

	await expect(verifyPassword(password, tamperedHash)).resolves.toBe(false)
})
