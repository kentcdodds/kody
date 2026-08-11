import { expect, test } from 'vitest'

import { createPasswordHash, verifyPassword } from './password-hash.ts'

// Workerd caps PBKDF2 at 100,000 iterations (crypto.subtle.deriveBits throws
// NotSupportedError above it), which Node-pool tests cannot catch. This suite
// runs the hash paths in the actual Workers runtime.
test('password hashes can be created and verified in the Workers runtime', async () => {
	const password = 'kodylovesyou'
	const hash = await createPasswordHash(password)
	await expect(verifyPassword(password, hash)).resolves.toBe(true)
	await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false)
})

test('the dummy hash used for timing-equalization verifies in the Workers runtime', async () => {
	const dummyPasswordHash =
		'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'
	await expect(verifyPassword('any-password', dummyPasswordHash)).resolves.toBe(
		false,
	)
})
