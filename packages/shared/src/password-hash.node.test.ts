import { expect, test } from 'vitest'

import { createPasswordHash, verifyPassword } from './password-hash.ts'

test('verifyPassword accepts valid hashes and rejects tampered metadata', async () => {
	const password = 'kodylovesyou'
	const hash = await createPasswordHash(password)

	await expect(verifyPassword(password, hash)).resolves.toBe(true)

	const [prefix, iterations, saltHex, hashHex] = hash.split('$')
	const tamperedHashes = [
		`${prefix}$${iterations}abc$${saltHex}$${hashHex}`,
		`${prefix}$100001$${saltHex}$${hashHex}`,
		`${prefix}$${iterations}$${saltHex}xyz$${hashHex}`,
	]

	for (const tamperedHash of tamperedHashes) {
		await expect(verifyPassword(password, tamperedHash)).resolves.toBe(false)
	}
})
