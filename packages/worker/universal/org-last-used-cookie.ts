import { isOrganizationSlug } from '#universal/org-pages.ts'

const lastUsedOrgCookieName = 'kody_last_org'
const lastUsedOrgMaxAgeSeconds = 60 * 60 * 24 * 365

export function readLastUsedOrgSlug(cookieHeader: string | null | undefined) {
	if (!cookieHeader) return null
	let latest: string | null = null
	for (const part of cookieHeader.split(';')) {
		const trimmed = part.trim()
		const separator = trimmed.indexOf('=')
		if (separator <= 0) continue
		if (trimmed.slice(0, separator) !== lastUsedOrgCookieName) continue
		let raw = trimmed.slice(separator + 1)
		try {
			raw = decodeURIComponent(raw)
		} catch {
			continue
		}
		const slug = raw.trim().toLowerCase()
		if (isOrganizationSlug(slug)) latest = slug
	}
	return latest
}

export function serializeLastUsedOrgCookie(input: {
	slug: string
	secure: boolean
}) {
	const slug = input.slug.trim().toLowerCase()
	if (!isOrganizationSlug(slug)) {
		throw new Error('Cannot remember an organization without a valid slug.')
	}
	const pieces = [
		`${lastUsedOrgCookieName}=${encodeURIComponent(slug)}`,
		'Path=/',
		`Max-Age=${lastUsedOrgMaxAgeSeconds}`,
		'HttpOnly',
		'SameSite=Lax',
	]
	if (input.secure) pieces.push('Secure')
	return pieces.join('; ')
}
