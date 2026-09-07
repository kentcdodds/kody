import { expect, test } from 'vitest'

import { timingSafeEqualBytes, timingSafeEqualString } from './timing-safe.ts'

test('timing-safe compares accept equal secrets and reject mismatches', async () => {
	await expect(timingSafeEqualString('secret', 'secret')).resolves.toBe(true)
	await expect(timingSafeEqualString('secret', 'wrong')).resolves.toBe(false)
	await expect(timingSafeEqualString('short', 'longer-secret')).resolves.toBe(
		false,
	)
	await expect(timingSafeEqualString('', '')).resolves.toBe(true)
	await expect(timingSafeEqualString('', 'x')).resolves.toBe(false)

	const left = new Uint8Array([1, 2, 3])
	expect(timingSafeEqualBytes(left, new Uint8Array([1, 2, 3]))).toBe(true)
	expect(timingSafeEqualBytes(left, new Uint8Array([1, 2, 4]))).toBe(false)
	expect(timingSafeEqualBytes(left, new Uint8Array([1, 2]))).toBe(false)
	expect(timingSafeEqualBytes(new Uint8Array(), new Uint8Array())).toBe(true)
})
