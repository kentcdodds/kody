import { expect, test } from 'vitest'

import { createPasswordHash, verifyPassword } from './password-hash.ts'

// Workerd caps PBKDF2 at 100,000 iterations (crypto.subtle.deriveBits throws
// NotSupportedError above it), which Node-pool tests cannot catch. This suite
// runs the hash paths in the actual Workers runtime.
test('password hashes and the timing-equalization dummy verify in the Workers runtime', async () => {
	const password = 'kodylovesyou'
	const hash = await createPasswordHash(password)
	await expect(verifyPassword(password, hash)).resolves.toBe(true)
	await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false)

	const dummyPasswordHash =
		'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'
	await expect(verifyPassword('any-password', dummyPasswordHash)).resolves.toBe(
		false,
	)
})
