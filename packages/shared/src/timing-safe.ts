import { sha256Bytes } from './sha256.ts'

function padToLength(buffer: Uint8Array, length: number) {
	if (buffer.length === length) return buffer
	const padded = new Uint8Array(length)
	padded.set(buffer)
	return padded
}

/**
 * Constant-time byte compare. Pads both sides to the longer length so a
 * length mismatch does not short-circuit, then requires equal lengths for
 * a true result.
 */
export function timingSafeEqualBytes(
	left: Uint8Array,
	right: Uint8Array,
): boolean {
	const maxLength = Math.max(left.length, right.length)
	const leftPadded = padToLength(left, maxLength)
	const rightPadded = padToLength(right, maxLength)
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (
			a: ArrayBuffer | ArrayBufferView,
			b: ArrayBuffer | ArrayBufferView,
		) => boolean
	}
	// Workers expose timingSafeEqual on subtle; Node unit tests do not.
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

/**
 * Constant-time string compare: SHA-256 both sides, then compare digests so
 * length differences do not leak via short-circuit string compares.
 */
export async function timingSafeEqualString(
	left: string,
	right: string,
): Promise<boolean> {
	const [leftDigest, rightDigest] = await Promise.all([
		sha256Bytes(left),
		sha256Bytes(right),
	])
	return timingSafeEqualBytes(leftDigest, rightDigest)
}
