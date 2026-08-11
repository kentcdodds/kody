import { expect, test } from 'vitest'

import {
	createPasswordHash,
	passwordHashNeedsUpgrade,
	verifyPassword,
} from './password-hash.ts'

async function createLegacyHash(password: string, iterations: number) {
	const hash = await createPasswordHash(password)
	const [prefix, , saltHex] = hash.split('$')
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	)
	const salt = new Uint8Array(
		saltHex!.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
	)
	const derived = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
			key,
			256,
		),
	)
	const derivedHex = Array.from(derived, (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return `${prefix}$${iterations}$${saltHex}$${derivedHex}`
}

test('legacy lower-iteration hashes still verify and are flagged for upgrade', async () => {
	const password = 'kodylovesyou'
	const legacyHash = await createLegacyHash(password, 100_000)

	await expect(verifyPassword(password, legacyHash)).resolves.toBe(true)
	expect(passwordHashNeedsUpgrade(legacyHash)).toBe(true)

	const currentHash = await createPasswordHash(password)
	expect(passwordHashNeedsUpgrade(currentHash)).toBe(false)
})

test('hashes above the generation setting verify but absurd iteration counts are rejected', async () => {
	const password = 'kodylovesyou'
	const futureHash = await createLegacyHash(password, 700_000)
	await expect(verifyPassword(password, futureHash)).resolves.toBe(true)
	expect(passwordHashNeedsUpgrade(futureHash)).toBe(false)

	const [prefix, , saltHex, hashHex] = futureHash.split('$')
	const absurdHash = `${prefix}$20000000$${saltHex}$${hashHex}`
	await expect(verifyPassword(password, absurdHash)).resolves.toBe(false)
})

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
