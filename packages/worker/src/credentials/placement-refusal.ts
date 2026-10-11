/**
 * Stable marker for a fetch the gateway refused because a credential
 * placeholder sat outside its declared header (or on plain HTTP). Only the
 * error message crosses the sandbox boundary, so the gateway appends this tag
 * to the message and surfaces downstream (webhook responses) read it back.
 * The tag carries the slot name only, never a value.
 */
export const credentialPlacementRefusedCode = 'credential_placement_refused'

const slotNamePattern = /^[a-zA-Z0-9._-]+$/
const refusalTagPattern =
	/\(credential_placement_refused(?:, slot "([a-zA-Z0-9._-]+)")?\)/

export function formatCredentialPlacementRefusalTag(slot: string | null) {
	return slot && slotNamePattern.test(slot)
		? `(${credentialPlacementRefusedCode}, slot "${slot}")`
		: `(${credentialPlacementRefusedCode})`
}

export function readCredentialPlacementRefusal(
	message: string,
): { slot: string | null } | null {
	const match = refusalTagPattern.exec(message)
	if (!match) return null
	return { slot: match[1] ?? null }
}

/** Reads the refusal tag from a package invocation error response body. */
export function readCredentialPlacementRefusalFromInvocationBody(
	body: unknown,
): { slot: string | null } | null {
	if (!body || typeof body !== 'object') return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object') return null
	const message = (error as Record<string, unknown>)['message']
	return typeof message === 'string'
		? readCredentialPlacementRefusal(message)
		: null
}

/**
 * The error a webhook caller sees: the code and slot name, nothing from the
 * package, the request, or the credential.
 */
export function buildCredentialPlacementRefusedWebhookError(
	slot: string | null,
) {
	const slotPhrase = slot ? ` (slot "${slot}")` : ''
	return {
		code: credentialPlacementRefusedCode,
		message: `The package tried to send a credential${slotPhrase} somewhere other than a declared request header, so Kody refused the request. The package owner needs to update the package.`,
		...(slot ? { slot } : {}),
	}
}
