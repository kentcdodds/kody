/**
 * Allow only same-origin absolute paths (with optional query/hash) as
 * post-auth redirect targets. Rejects protocol-relative URLs, backslash
 * network-path tricks browsers normalize to `//host`, control characters,
 * and other host-hijacking forms.
 */
export function normalizeRedirectTo(value: string | null | undefined) {
	if (typeof value !== 'string' || value.length === 0) return null
	if (!value.startsWith('/')) return null
	// Browsers treat `\` as `/`, so `/\evil` becomes a network-path `//evil`.
	if (value.includes('\\') || /%5c/i.test(value)) return null
	// Protocol-relative / network-path references.
	if (value.startsWith('//')) return null
	// Raw controls/whitespace confuse Location parsers and URL normalizers.
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f || code === 0x20) return null
	}
	// Percent-encoded C0 controls and DEL (encoded spaces in paths stay valid).
	if (/%(?:[01][\da-f]|7f)/i.test(value)) return null
	try {
		const url = new URL(value, 'https://kody.invalid')
		if (url.origin !== 'https://kody.invalid') return null
		if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) {
			return null
		}
	} catch {
		return null
	}
	return value
}

/** Destination after email verification succeeds when no safer target exists. */
export const defaultPostVerificationRedirect = '/onboarding'

/** Destination after email verification succeeds from pending/verify flows. */
export function resolvePostVerificationRedirect(redirectTo?: string | null) {
	return normalizeRedirectTo(redirectTo) ?? defaultPostVerificationRedirect
}

/** Success CTA for `/verify-email`, preserving a safe OAuth (or other) resume target. */
export function resolveVerifyEmailSuccessCta(redirectTo?: string | null) {
	const href = resolvePostVerificationRedirect(redirectTo)
	if (href === defaultPostVerificationRedirect) {
		return {
			href,
			label: 'Continue to onboarding',
			message:
				'Your email address has been verified. MCP access is now available. Continue onboarding to connect your AI agent.',
		}
	}
	if (href.startsWith('/oauth/authorize')) {
		return {
			href,
			label: 'Continue authorization',
			message:
				'Your email address has been verified. MCP access is now available. Continue authorization to finish connecting your AI agent.',
		}
	}
	return {
		href,
		label: 'Continue',
		message:
			'Your email address has been verified. MCP access is now available.',
	}
}
