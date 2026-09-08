import { isSiteBannerId } from '#universal/site-banners.ts'

export const siteBannerDismissCookieName = 'kody_site_banner_dismiss'
const maxDismissedIds = 40
const tenYearsSeconds = 60 * 60 * 24 * 365 * 10

export function requestHasSiteBannerDismissCookie(request: Request): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return new RegExp(`(?:^|;\\s*)${siteBannerDismissCookieName}=`).test(cookie)
}

export function readSiteBannerDismissCookie(
	cookieHeader: string | null,
): Array<string> {
	if (!cookieHeader) return []
	for (const part of cookieHeader.split(';')) {
		const trimmed = part.trim()
		const separator = trimmed.indexOf('=')
		if (separator <= 0) continue
		const name = trimmed.slice(0, separator)
		if (name !== siteBannerDismissCookieName) continue
		return parseDismissedIds(decodeCookieValue(trimmed.slice(separator + 1)))
	}
	return []
}

export function siteBannerDismissCookie(input: {
	ids: ReadonlyArray<string>
	secure: boolean
}): string {
	const ids = uniqueValidIds(input.ids)
	const value = encodeURIComponent(ids.join(','))
	const secure = input.secure ? '; Secure' : ''
	return `${siteBannerDismissCookieName}=${value}; Path=/; Max-Age=${String(tenYearsSeconds)}; SameSite=Lax; HttpOnly${secure}`
}

export function addDismissedBannerId(
	existing: ReadonlyArray<string>,
	bannerId: string,
): Array<string> {
	return uniqueValidIds([...existing, bannerId])
}

function parseDismissedIds(raw: string): Array<string> {
	if (!raw) return []
	return uniqueValidIds(raw.split(','))
}

function uniqueValidIds(ids: ReadonlyArray<string>): Array<string> {
	const seen = new Set<string>()
	for (const id of ids) {
		const trimmed = id.trim()
		if (!isSiteBannerId(trimmed)) continue
		seen.delete(trimmed)
		seen.add(trimmed)
	}
	const unique = [...seen]
	return unique.length <= maxDismissedIds
		? unique
		: unique.slice(-maxDismissedIds)
}

function decodeCookieValue(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}
