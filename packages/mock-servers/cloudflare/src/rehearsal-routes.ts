import { sha256Hex } from '@kody-internal/shared/sha256.ts'

/**
 * Public, stateless routes for the preview migration rehearsal
 * (`docs/contributing/preview-migration-rehearsal.md`).
 *
 * - `/__mocks/rehearsal/echo` returns SHA-256 hashes of the secret-bearing
 *   request headers, so a package can prove a `{{secret:…}}` placeholder (or
 *   an integration token) decrypted to the value seeded earlier without the
 *   value ever leaving Kody.
 * - `/__mocks/rehearsal/oauth/token` is an OAuth token endpoint that accepts
 *   any authorization code or refresh token, so the preview can hold real
 *   integration connections with a refreshable token.
 *
 * Neither route reads or stores anything: the echo only hashes what the
 * caller sent, and the token endpoint mints random strings.
 */
export const rehearsalEchoPath = '/__mocks/rehearsal/echo'
export const rehearsalOauthTokenPath = '/__mocks/rehearsal/oauth/token'
export const rehearsalSecretHeader = 'x-rehearsal-secret'

const echoedHeaders = ['authorization', rehearsalSecretHeader] as const

function randomToken(prefix: string) {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

async function handleEcho(request: Request) {
	const hashes: Record<string, string | null> = {}
	for (const name of echoedHeaders) {
		const value = request.headers.get(name)
		hashes[name] = value ? await sha256Hex(value) : null
	}
	return Response.json(
		{ ok: true, method: request.method, sha256: hashes },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

async function readTokenRequest(request: Request) {
	const text = await request.text()
	const contentType = request.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) {
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>
			return new URLSearchParams(
				Object.entries(parsed).flatMap(([key, value]) =>
					typeof value === 'string' ? [[key, value]] : [],
				),
			)
		} catch {
			return new URLSearchParams()
		}
	}
	return new URLSearchParams(text)
}

async function handleOauthToken(request: Request) {
	const params = await readTokenRequest(request)
	const grantType = params.get('grant_type')
	const credential =
		grantType === 'authorization_code'
			? params.get('code')
			: grantType === 'refresh_token'
				? params.get('refresh_token')
				: null
	if (!credential) {
		return Response.json(
			{
				error: 'invalid_request',
				error_description:
					'Send grant_type=authorization_code with a code, or grant_type=refresh_token with a refresh_token.',
			},
			{ status: 400 },
		)
	}
	return Response.json(
		{
			access_token: randomToken('rehearsal_at_'),
			refresh_token: randomToken('rehearsal_rt_'),
			token_type: 'bearer',
			expires_in: 3600,
			scope: params.get('scope') ?? 'rehearsal.read',
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

export async function routeRehearsal(request: Request, url: URL) {
	if (url.pathname === rehearsalEchoPath) return handleEcho(request)
	if (url.pathname === rehearsalOauthTokenPath && request.method === 'POST') {
		return handleOauthToken(request)
	}
	return null
}
