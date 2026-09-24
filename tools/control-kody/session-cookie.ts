export const cookieOriginPrefix = '# origin='

export function normalizeCookieOrigin(origin: string) {
	return origin.replace(/\/$/, '')
}

export function formatCookieFile(origin: string, cookieHeader: string) {
	return `${cookieOriginPrefix}${normalizeCookieOrigin(origin)}\n${cookieHeader}\n`
}

export function cookieHeaderForOrigin(fileText: string, origin: string) {
	const trimmed = fileText.trim()
	if (!trimmed) return null
	const firstNewline = trimmed.indexOf('\n')
	const firstLine =
		firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline)
	if (!firstLine.startsWith(cookieOriginPrefix)) return null
	const stored = firstLine.slice(cookieOriginPrefix.length).trim()
	if (stored !== normalizeCookieOrigin(origin)) return null
	const rest = firstNewline === -1 ? '' : trimmed.slice(firstNewline + 1).trim()
	return rest.length > 0 ? rest : null
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
