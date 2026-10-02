export const cookieOriginPrefix = '# origin='
export const cookieEmailPrefix = '# email='
export const oauthClientIdPrefix = '# oauth-client-id='
export const oauthClientSecretPrefix = '# oauth-client-secret='
export const oauthRedirectUriPrefix = '# oauth-redirect-uri='
export const oauthAccessTokenPrefix = '# oauth-access-token='

export type AppSessionOAuth = {
	clientId: string
	clientSecret: string
	redirectUri: string
	accessToken: string
}

export type AppSessionFile = {
	origin: string
	email: string | null
	cookieHeader: string | null
	oauth: AppSessionOAuth | null
}

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
	oauth?: AppSessionOAuth | null,
) {
	const lines = [`${cookieOriginPrefix}${normalizeCookieOrigin(origin)}`]
	if (email) lines.push(`${cookieEmailPrefix}${normalizeCookieEmail(email)}`)
	if (oauth) {
		lines.push(`${oauthClientIdPrefix}${oauth.clientId}`)
		lines.push(`${oauthClientSecretPrefix}${oauth.clientSecret}`)
		lines.push(`${oauthRedirectUriPrefix}${oauth.redirectUri}`)
		lines.push(`${oauthAccessTokenPrefix}${oauth.accessToken}`)
	}
	return `${lines.join('\n')}\n${cookieHeader}\n`
}

function readPrefixedLine(line: string, prefix: string) {
	if (!line.startsWith(prefix)) return null
	const value = line.slice(prefix.length).trim()
	return value.length > 0 ? value : null
}

function parseCookieFile(fileText: string): AppSessionFile | null {
	const trimmed = fileText.trim()
	if (!trimmed) return null
	const lines = trimmed.split(/\r?\n/)
	const firstLine = lines[0] ?? ''
	if (!firstLine.startsWith(cookieOriginPrefix)) return null
	const origin = firstLine.slice(cookieOriginPrefix.length).trim()
	let email: string | null = null
	let clientId: string | null = null
	let clientSecret: string | null = null
	let redirectUri: string | null = null
	let accessToken: string | null = null
	const cookieLines: Array<string> = []
	for (const line of lines.slice(1)) {
		const nextEmail = readPrefixedLine(line, cookieEmailPrefix)
		if (nextEmail !== null) {
			email = normalizeCookieEmail(nextEmail)
			continue
		}
		const nextClientId = readPrefixedLine(line, oauthClientIdPrefix)
		if (nextClientId !== null) {
			clientId = nextClientId
			continue
		}
		const nextClientSecret = readPrefixedLine(line, oauthClientSecretPrefix)
		if (nextClientSecret !== null) {
			clientSecret = nextClientSecret
			continue
		}
		const nextRedirectUri = readPrefixedLine(line, oauthRedirectUriPrefix)
		if (nextRedirectUri !== null) {
			redirectUri = nextRedirectUri
			continue
		}
		const nextAccessToken = readPrefixedLine(line, oauthAccessTokenPrefix)
		if (nextAccessToken !== null) {
			accessToken = nextAccessToken
			continue
		}
		if (line.startsWith('#')) continue
		cookieLines.push(line)
	}
	const cookieHeader = cookieLines.join('\n').trim()
	const oauth =
		clientId && clientSecret && redirectUri && accessToken
			? { clientId, clientSecret, redirectUri, accessToken }
			: null
	return {
		origin,
		email,
		cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
		oauth,
	}
}

export function sessionForOrigin(
	fileText: string,
	origin: string,
	email?: string | null,
): AppSessionFile | null {
	const parsed = parseCookieFile(fileText)
	if (!parsed) return null
	if (parsed.origin !== normalizeCookieOrigin(origin)) return null
	if (email) {
		if (!parsed.email) return null
		if (parsed.email !== normalizeCookieEmail(email)) return null
	}
	return parsed
}

export function cookieHeaderForOrigin(
	fileText: string,
	origin: string,
	email?: string | null,
) {
	return sessionForOrigin(fileText, origin, email)?.cookieHeader ?? null
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
