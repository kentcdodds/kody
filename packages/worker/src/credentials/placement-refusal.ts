/**
 * Stable marker for a fetch the gateway refused because a credential
 * placeholder was headed to a host its credential does not allow, over plain
 * HTTP, or into the URL host. Only the error message crosses the sandbox
 * boundary, so the gateway appends this tag to the message and surfaces
 * downstream (webhook responses) read it back. The tag carries the slot name
 * only, never a value.
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

/** `message` without a trailing refusal tag, for messages parsed further. */
export function stripCredentialPlacementRefusalTag(message: string) {
	return message.replace(new RegExp(`\\s*${refusalTagPattern.source}\\s*$`), '')
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
		message: `The package tried to send a credential${slotPhrase} to a host the credential does not allow, over plain HTTP, or in the URL host, so Kody refused the request. The package owner or the credential's owner needs to fix it.`,
		...(slot ? { slot } : {}),
	}
}
