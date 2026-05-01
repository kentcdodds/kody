const tokenBytes = new Uint8Array(32)
crypto.getRandomValues(tokenBytes)

/**
 * Per-isolate random token used to gate non-WebSocket HTTP helper
 * endpoints on HomeConnectorSession. Only Worker-internal callers
 * (via DO stub) can set this header — public requests never reach
 * the DO for non-upgrade HTTP because the entrypoint rejects them.
 * This is the second layer of defense.
 */
export const internalCallToken = Array.from(tokenBytes, (b) =>
	b.toString(16).padStart(2, '0'),
).join('')

export function internalCallHeaders(): HeadersInit {
	return { 'X-Kody-Internal': internalCallToken }
}
