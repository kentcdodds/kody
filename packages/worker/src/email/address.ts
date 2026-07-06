const mailboxAddressPattern = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i

export function normalizeEmailAddress(value: string) {
	const match = value.trim().match(mailboxAddressPattern)
	const address = match?.[1]?.trim().toLowerCase() ?? ''
	return address.length > 0 ? address : null
}

export function requireNormalizedEmailAddress(value: string, label = 'Email') {
	const normalized = normalizeEmailAddress(value)
	if (!normalized) {
		throw new Error(`${label} must be a valid email address.`)
	}
	return normalized
}

export function getEmailDomain(address: string) {
	const normalized = requireNormalizedEmailAddress(address)
	const at = normalized.lastIndexOf('@')
	return normalized.slice(at + 1)
}

export function getEmailLocalPart(address: string) {
	const normalized = requireNormalizedEmailAddress(address)
	const at = normalized.lastIndexOf('@')
	return normalized.slice(0, at)
}

/**
 * Split an email local part into its base and RFC 5233 subaddress tag
 * (`user+tag` → base `user`, subaddress `tag`). The tag starts at the first
 * `+`; a missing or empty tag yields null.
 */
export function splitEmailLocalPart(localPart: string) {
	const plusIndex = localPart.indexOf('+')
	if (plusIndex === -1) {
		return { base: localPart, subaddress: null }
	}
	const base = localPart.slice(0, plusIndex)
	const subaddress = localPart.slice(plusIndex + 1)
	return { base, subaddress: subaddress.length > 0 ? subaddress : null }
}

export function normalizeEmailAddressList(values: ReadonlyArray<string>) {
	return Array.from(
		new Set(
			values
				.map((value) => normalizeEmailAddress(value))
				.filter((value): value is string => value !== null),
		),
	)
}

export function parseHeaderEmailAddressList(value: string | null | undefined) {
	if (!value) return []
	return normalizeEmailAddressList(value.split(','))
}

export function parseHeaderAddressList(value: string | null | undefined) {
	return parseHeaderEmailAddressList(value).map((address) => ({
		name: null,
		address,
	}))
}

export function normalizeSubject(subject: string | null | undefined) {
	const trimmed = subject?.trim() ?? ''
	return trimmed
		.replace(/^(?:(?:re|fw|fwd):\s*)+/i, '')
		.replace(/\s+/g, ' ')
		.toLowerCase()
}

export function extractReplyToken(input: {
	headers: Headers
	recipients: ReadonlyArray<string>
}) {
	const explicit =
		input.headers.get('X-Kody-Reply-Token') ??
		input.headers.get('X-Reply-Token') ??
		null
	if (explicit?.trim()) return explicit.trim()
	for (const recipient of input.recipients) {
		const normalized = normalizeEmailAddress(recipient)
		if (!normalized) continue
		const localPart = getEmailLocalPart(normalized)
		const match =
			localPart.match(/\bkody-r-([a-f0-9]{16,128})\b/i) ??
			localPart.match(/\+reply-([a-z0-9_-]+)/i)
		if (match?.[1]) return match[1]
	}
	return null
}
