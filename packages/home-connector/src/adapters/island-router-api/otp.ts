import { createHmac } from 'node:crypto'

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(value: string) {
	const normalized = value.toUpperCase().replaceAll(/\s|=/g, '')
	let bits = 0
	let bitCount = 0
	const bytes: Array<number> = []
	for (const character of normalized) {
		const index = base32Alphabet.indexOf(character)
		if (index === -1) {
			throw new Error('Invalid base32 secret.')
		}
		bits = (bits << 5) | index
		bitCount += 5
		while (bitCount >= 8) {
			bytes.push((bits >> (bitCount - 8)) & 0xff)
			bitCount -= 8
		}
	}
	return Buffer.from(bytes)
}

export function computeIslandRouterHotp(input: {
	secret: string
	counter: number
}) {
	if (!Number.isSafeInteger(input.counter) || input.counter < 0) {
		throw new Error('HOTP counter must be a non-negative safe integer.')
	}
	const counterBuffer = Buffer.alloc(8)
	counterBuffer.writeBigUInt64BE(BigInt(input.counter))
	const digest = createHmac('sha1', decodeBase32(input.secret))
		.update(counterBuffer)
		.digest()
	const offset = digest[digest.length - 1]! & 0x0f
	const code =
		(((digest[offset]! & 0x7f) << 24) |
			((digest[offset + 1]! & 0xff) << 16) |
			((digest[offset + 2]! & 0xff) << 8) |
			(digest[offset + 3]! & 0xff)) %
		1_000_000
	return code.toString().padStart(6, '0')
}
