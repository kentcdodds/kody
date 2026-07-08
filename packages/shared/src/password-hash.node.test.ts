import { expect, test } from 'vitest'

import {
	createPasswordHash,
	hasUsablePasswordHash,
	verifyPassword,
} from './password-hash.ts'

test('verifyPassword accepts valid hashes and rejects tampered metadata', async () => {
	const password = 'kodylovesyou'
	const hash = await createPasswordHash(password)

	await expect(verifyPassword(password, hash)).resolves.toBe(true)
	expect(hasUsablePasswordHash(hash)).toBe(true)
	expect(hasUsablePasswordHash('oauth_only_no_usable_password')).toBe(false)
	expect(hasUsablePasswordHash('admin_created_no_usable_password')).toBe(false)
	await expect(
		verifyPassword(password, 'oauth_only_no_usable_password'),
	).resolves.toBe(false)

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
