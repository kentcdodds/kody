import { toHex } from './hex.ts'

const passwordHashPrefix = 'pbkdf2_sha256'
const passwordSaltBytes = 16
const passwordHashBytes = 32
const maxPasswordHashIterations = 100_000
const passwordHashIterations = maxPasswordHashIterations

function fromHex(value: string): Uint8Array<ArrayBuffer> | null {
	const normalized = value.trim().toLowerCase()
	if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
		return null
	}
	const bytes = new Uint8Array(normalized.length / 2)
	for (let index = 0; index < normalized.length; index += 2) {
		const byte = Number.parseInt(normalized.slice(index, index + 2), 16)
		if (Number.isNaN(byte)) return null
		bytes[index / 2] = byte
	}
	return bytes
}

function padToLength(buffer: Uint8Array, length: number) {
	if (buffer.length === length) return buffer
	const padded = new Uint8Array(length)
	padded.set(buffer)
	return padded
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
	const maxLength = Math.max(left.length, right.length)
	const leftPadded = padToLength(left, maxLength)
	const rightPadded = padToLength(right, maxLength)
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (
			a: ArrayBuffer | ArrayBufferView,
			b: ArrayBuffer | ArrayBufferView,
		) => boolean
	}
	const isEqual =
		typeof subtle.timingSafeEqual === 'function'
			? subtle.timingSafeEqual(leftPadded, rightPadded)
			: (() => {
					let result = 0
					for (let index = 0; index < maxLength; index += 1) {
						const leftValue = leftPadded[index] ?? 0
						const rightValue = rightPadded[index] ?? 0
						result |= leftValue ^ rightValue
					}
					return result === 0
				})()
	return isEqual && left.length === right.length
}

async function derivePasswordKey(
	password: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
	length: number,
) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	)
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt,
			iterations,
			hash: 'SHA-256',
		},
		key,
		length * 8,
	)
	return new Uint8Array(derivedBits)
}

export async function createPasswordHash(password: string) {
	const salt = new Uint8Array(new ArrayBuffer(passwordSaltBytes))
	crypto.getRandomValues(salt)
	const hash = await derivePasswordKey(
		password,
		salt,
		passwordHashIterations,
		passwordHashBytes,
	)
	return `${passwordHashPrefix}$${passwordHashIterations}$${toHex(salt)}$${toHex(
		hash,
	)}`
}

export async function verifyPassword(
	password: string,
	storedHash: string,
): Promise<boolean> {
	if (!storedHash) {
		return false
	}
	const normalizedHash = storedHash.trim()
	if (normalizedHash.startsWith(`${passwordHashPrefix}$`)) {
		const [prefix, iterationsRaw, saltHex, hashHex, ...extra] =
			normalizedHash.split('$')
		if (prefix !== passwordHashPrefix || extra.length > 0) {
			return false
		}
		if (!iterationsRaw || !/^\d+$/.test(iterationsRaw)) return false
		const iterations = Number(iterationsRaw)
		const salt = saltHex ? fromHex(saltHex) : null
		const hash = hashHex ? fromHex(hashHex) : null
		if (!Number.isSafeInteger(iterations) || iterations < 1 || !salt || !hash) {
			return false
		}
		if (iterations > maxPasswordHashIterations) {
			return false
		}
		const derived = await derivePasswordKey(
			password,
			salt,
			iterations,
			hash.length,
		)
		return timingSafeEqual(derived, hash)
	}

	return false
}
