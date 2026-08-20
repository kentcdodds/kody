export const cliClientIdMetadataPath = '/oauth/cli-client-metadata.json'
export const cliOAuthCallbackUrl = 'http://127.0.0.1:43742/callback'
export const cliClientName = '@kodycodes/cli'
export const cliClientUri = 'https://github.com/kody-bot/cli'

/**
 * Official CLI Client ID Metadata Document (SEP-991).
 *
 * The CLI presents this HTTPS URL as `client_id`. Loopback redirect is fixed
 * so the document can list it; ephemeral ports would force deprecated DCR.
 */
export function buildCliClientIdMetadataDocument(origin: string) {
	const clientOrigin = new URL(origin).origin
	const clientId = `${clientOrigin}${cliClientIdMetadataPath}`
	return {
		client_id: clientId,
		client_name: cliClientName,
		client_uri: cliClientUri,
		redirect_uris: [cliOAuthCallbackUrl],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'native',
		scope: 'profile email',
	}
}

export function isCliClientIdMetadataRequest(pathname: string) {
	return pathname === cliClientIdMetadataPath
}

export function handleCliClientIdMetadataRequest(request: Request) {
	const url = new URL(request.url)
	if (!isCliClientIdMetadataRequest(url.pathname)) return null
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: { 'Content-Length': '0' },
		})
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') return null

	const body = JSON.stringify(buildCliClientIdMetadataDocument(url.origin))
	const headers = {
		'Content-Type': 'application/json',
		'Cache-Control': 'public, max-age=3600',
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return new Response(body, { headers })
}
