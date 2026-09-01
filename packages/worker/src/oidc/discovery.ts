import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'

export function buildOpenIdConfiguration(input: {
	env: Env
	request: Request
}) {
	const issuer = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	return {
		issuer,
		authorization_endpoint: `${issuer}${oauthPaths.authorize}`,
		token_endpoint: `${issuer}${oauthPaths.token}`,
		userinfo_endpoint: `${issuer}${oauthPaths.userinfo}`,
		jwks_uri: `${issuer}${oauthPaths.jwks}`,
		end_session_endpoint: `${issuer}${oauthPaths.logout}`,
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		subject_types_supported: ['public'],
		id_token_signing_alg_values_supported: ['RS256'],
		scopes_supported: mcpOauthScopes,
		claims_supported: [
			'sub',
			'iss',
			'aud',
			'exp',
			'iat',
			'auth_time',
			'nonce',
			'email',
			'email_verified',
			'preferred_username',
		],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: [
			'none',
			'client_secret_basic',
			'client_secret_post',
		],
		code_challenge_methods_supported: ['S256'],
	}
}

export function handleOpenIdConfigurationRequest(request: Request, env: Env) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405 })
	}
	const body = JSON.stringify(buildOpenIdConfiguration({ env, request }))
	const headers = {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return new Response(body, { status: 200, headers })
}
