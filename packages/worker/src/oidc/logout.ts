import  {
	type ClientInfo,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { verifyOidcJwtSignature } from '#worker/oidc/keys.ts'

type OAuthEnv = Env & {
	OAUTH_PROVIDER: OAuthHelpers
}

function getOAuthHelpers(env: Env) {
	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		throw new Error('OAuth provider helpers are not available.')
	}
	return helpers
}

function readRegisteredRedirectUris(client: ClientInfo) {
	const redirectUris = (client as { redirectUris?: unknown }).redirectUris
	return Array.isArray(redirectUris) &&
		redirectUris.every((uri) => typeof uri === 'string')
		? redirectUris
		: null
}

function isAllowedPostLogoutRedirectUri(
	redirectUri: string,
	registeredUris: Array<string> | null,
) {
	if (!registeredUris) return false
	return registeredUris.some((registeredUri) => registeredUri === redirectUri)
}

export async function handleOidcLogoutRequest(request: Request, env: Env) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405 })
	}

	const url = new URL(request.url)
	const postLogoutRedirectUri =
		url.searchParams.get('post_logout_redirect_uri')?.trim() || null
	const state = url.searchParams.get('state')?.trim() || null
	const idTokenHint = url.searchParams.get('id_token_hint')?.trim() || null
	const clientId = url.searchParams.get('client_id')?.trim() || null

	if (postLogoutRedirectUri) {
		let allowed = false
		if (clientId) {
			const helpers = getOAuthHelpers(env)
			try {
				const client = await helpers.lookupClient(clientId)
				if (client) {
					allowed = isAllowedPostLogoutRedirectUri(
						postLogoutRedirectUri,
						readRegisteredRedirectUris(client),
					)
				}
			} catch {
				allowed = false
			}
		}
		if (!allowed) {
			return new Response('Invalid post_logout_redirect_uri', { status: 400 })
		}
	}

	if (idTokenHint) {
		const issuer = getAppBaseUrl({
			env,
			requestUrl: request.url,
		})
		const payload = await verifyOidcJwtSignature(env, idTokenHint)
		if (!payload || payload.iss !== issuer) {
			return new Response('Invalid id_token_hint', { status: 400 })
		}
	}

	const clearSessionCookie = await destroyAuthCookie(isSecureRequest(request))
	const headers = new Headers({
		'Cache-Control': 'no-store',
		'Set-Cookie': clearSessionCookie,
	})

	if (postLogoutRedirectUri) {
		const redirectUrl = new URL(postLogoutRedirectUri)
		if (state) redirectUrl.searchParams.set('state', state)
		headers.set('Location', redirectUrl.toString())
		return new Response(null, { status: 302, headers })
	}

	return new Response('Signed out.', {
		status: 200,
		headers,
	})
}
