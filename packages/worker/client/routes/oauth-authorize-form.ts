/**
 * Native consent-form defaults for `/oauth/authorize`.
 *
 * A method-less form GETs the pathname with field names only, which replaces
 * the OAuth query string with `kody_hp=` and surfaces a misleading
 * `client_id is required`. POST to pathname+search keeps those params, and the
 * hidden approve decision matches the submit button.
 */
export const oauthAuthorizeConsentDecision = 'approve' as const

export function oauthAuthorizeConsentFormAttrs(href: string) {
	const url = new URL(href, 'http://localhost')
	return {
		method: 'post' as const,
		action: `${url.pathname}${url.search}`,
	}
}

/** `hydrated` is post-hydrate interactivity, not `typeof document`. */
export function oauthAuthorizeActionsDisabled(input: {
	hydrated: boolean
	statusReady: boolean
	submitting: boolean
	sessionLoading: boolean
	needsEmailVerification: boolean
}) {
	return (
		!input.hydrated ||
		!input.statusReady ||
		input.submitting ||
		input.sessionLoading ||
		input.needsEmailVerification
	)
}

export function oauthAuthorizeApproveAriaLabel(input: {
	hydrated: boolean
	label: string
}) {
	if (input.hydrated) return undefined
	return `${input.label} (available after the page finishes loading)`
}
