import { expect, test } from 'vitest'
import { ensureCryptoRandomUUID } from './ensure-crypto-random-uuid.ts'

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('ensureCryptoRandomUUID polyfills missing randomUUID from getRandomValues and leaves an existing implementation alone', () => {
	const bytes = new Uint8Array(16).fill(0xab)
	const getRandomValues = (target: Uint8Array) => {
		target.set(bytes.subarray(0, target.length))
		return target
	}
	const cryptoWithoutUuid = {
		getRandomValues,
	} as Crypto

	ensureCryptoRandomUUID(cryptoWithoutUuid)

	expect(typeof cryptoWithoutUuid.randomUUID).toBe('function')
	const first = cryptoWithoutUuid.randomUUID()
	expect(first).toMatch(uuidPattern)
	expect(first[14]).toBe('4')
	expect(['8', '9', 'a', 'b']).toContain(first[19]!.toLowerCase())

	const existing = () => 'already-present-uuid'
	const cryptoWithUuid = {
		getRandomValues,
		randomUUID: existing,
	} as Crypto

	ensureCryptoRandomUUID(cryptoWithUuid)
	expect(cryptoWithUuid.randomUUID).toBe(existing)
	expect(cryptoWithUuid.randomUUID()).toBe('already-present-uuid')

	const empty = {} as Crypto
	ensureCryptoRandomUUID(empty)
	expect(empty.randomUUID).toBeUndefined()

	ensureCryptoRandomUUID(undefined)
})
