import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { signOidcJwt } from '#worker/oidc/keys.ts'

export type OidcGrantProps = {
	userId: string
	email: string
	username: string
	displayName: string
	authTime: number
	nonce?: string
}

const idTokenLifetimeSeconds = 60 * 60

export async function mintIdToken(input: {
	env: Env
	request: Request
	clientId: string
	scope: Array<string>
	props: OidcGrantProps
	includeNonce: boolean
}) {
	const issuer = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const now = Math.floor(Date.now() / 1000)
	const claims: Record<string, unknown> = {
		iss: issuer,
		sub: input.props.userId,
		aud: input.clientId,
		iat: now,
		exp: now + idTokenLifetimeSeconds,
		auth_time: input.props.authTime,
	}
	if (input.scope.includes('email')) {
		claims.email = input.props.email
		claims.email_verified = true
	}
	if (input.scope.includes('profile')) {
		claims.preferred_username = input.props.username
	}
	if (input.includeNonce && input.props.nonce) {
		claims.nonce = input.props.nonce
	}
	return signOidcJwt(input.env, claims)
}
