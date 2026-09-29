export const cookieOriginPrefix = '# origin='
export const cookieEmailPrefix = '# email='

export function normalizeCookieOrigin(origin: string) {
	return origin.replace(/\/$/, '')
}

export function normalizeCookieEmail(email: string) {
	return email.trim().toLowerCase()
}

export function formatCookieFile(
	origin: string,
	cookieHeader: string,
	email?: string | null,
) {
	const lines = [`${cookieOriginPrefix}${normalizeCookieOrigin(origin)}`]
	if (email) lines.push(`${cookieEmailPrefix}${normalizeCookieEmail(email)}`)
	return `${lines.join('\n')}\n${cookieHeader}\n`
}

function parseCookieFile(fileText: string) {
	const trimmed = fileText.trim()
	if (!trimmed) return null
	const lines = trimmed.split(/\r?\n/)
	const firstLine = lines[0] ?? ''
	if (!firstLine.startsWith(cookieOriginPrefix)) return null
	const origin = firstLine.slice(cookieOriginPrefix.length).trim()
	let email: string | null = null
	let cookieStart = 1
	const secondLine = lines[1] ?? ''
	if (secondLine.startsWith(cookieEmailPrefix)) {
		email = normalizeCookieEmail(secondLine.slice(cookieEmailPrefix.length))
		cookieStart = 2
	}
	const cookieHeader = lines.slice(cookieStart).join('\n').trim()
	return {
		origin,
		email,
		cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
	}
}

export function cookieHeaderForOrigin(
	fileText: string,
	origin: string,
	email?: string | null,
) {
	const parsed = parseCookieFile(fileText)
	if (!parsed) return null
	if (parsed.origin !== normalizeCookieOrigin(origin)) return null
	if (email) {
		if (!parsed.email) return null
		if (parsed.email !== normalizeCookieEmail(email)) return null
	}
	return parsed.cookieHeader
}

export function looksLikeLoginHtml(rawBody: string) {
	for (const match of rawBody.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0]
		if (!/\brel="canonical"/i.test(tag)) continue
		if (!/\bdata-kody-head="canonical"/i.test(tag)) continue
		const href = tag.match(/\bhref="([^"]+)"/i)?.[1]
		if (!href) continue
		try {
			return new URL(href, 'https://control-kody.invalid').pathname === '/login'
		} catch {
			return false
		}
	}
	return false
}

export function shouldRefreshSession(input: {
	skipLogin: boolean
	status: number
	path: string
	rawBody: string
	method?: string
}) {
	if (input.skipLogin) return false
	if (input.status === 401) return true
	if (input.path === '/login') return false
	return looksLikeLoginHtml(input.rawBody)
}
