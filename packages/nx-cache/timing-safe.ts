function timingSafeEqualDigests(
	left: ArrayBuffer,
	right: ArrayBuffer,
): boolean {
	if (left.byteLength !== right.byteLength) return false
	const subtleWithTiming = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean
	}
	// Workers expose timingSafeEqual on subtle; Node unit tests do not.
	if (typeof subtleWithTiming.timingSafeEqual === 'function') {
		return subtleWithTiming.timingSafeEqual(left, right)
	}
	const a = new Uint8Array(left)
	const b = new Uint8Array(right)
	let diff = 0
	for (let index = 0; index < a.length; index += 1) {
		diff |= a[index]! ^ b[index]!
	}
	return diff === 0
}

/**
 * Constant-time bearer compare: SHA-256 both sides, then compare digests so
 * length differences do not leak via short-circuit string compares.
 */
export async function timingSafeEqualString(
	left: string,
	right: string,
): Promise<boolean> {
	const encoder = new TextEncoder()
	const [leftDigest, rightDigest] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	])
	return timingSafeEqualDigests(leftDigest, rightDigest)
}

export function readBearerToken(request: Request): string | null {
	const header = request.headers.get('authorization')
	if (!header) return null
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
	return match?.[1] ?? null
}
