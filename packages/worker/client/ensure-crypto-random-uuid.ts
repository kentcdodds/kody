/**
 * Remix's reconcile runtime calls `crypto.randomUUID()` for frame ids.
 * Some in-app browsers (e.g. Twitter/X on iOS) expose `crypto` /
 * `getRandomValues` but not `randomUUID`, which aborts client hydration.
 * Install a RFC 4122 v4 polyfill before `run()` when needed.
 */
export function ensureCryptoRandomUUID(
	cryptoApi: Crypto | undefined = globalThis.crypto,
): void {
	if (!cryptoApi) return
	if (typeof cryptoApi.randomUUID === 'function') return
	if (typeof cryptoApi.getRandomValues !== 'function') return

	const polyfill = function randomUUID(
		this: Crypto,
	): `${string}-${string}-${string}-${string}-${string}` {
		const bytes = new Uint8Array(16)
		this.getRandomValues(bytes)
		// Version 4 + RFC 4122 variant bits.
		bytes[6] = (bytes[6]! & 0x0f) | 0x40
		bytes[8] = (bytes[8]! & 0x3f) | 0x80
		const hex = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('')
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
	}

	try {
		Object.defineProperty(cryptoApi, 'randomUUID', {
			configurable: true,
			enumerable: false,
			writable: true,
			value: polyfill,
		})
	} catch {
		try {
			cryptoApi.randomUUID = polyfill
		} catch {
			// Leave crypto unchanged; Remix will still throw if it calls randomUUID.
		}
	}
}
