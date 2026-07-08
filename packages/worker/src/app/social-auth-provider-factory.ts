import {
	createGitHubAuthProvider,
	createGoogleAuthProvider,
	createXAuthProvider,
	type OAuthProvider,
} from 'remix/auth'
import { type SocialAuthProfile } from '#app/resolve-social-auth.ts'
import {
	getSocialAuthStartPath,
	isSocialAuthMockEnabled,
	type SocialAuthProviderName,
} from '#app/social-auth-providers.ts'

const mockClientId = 'mock-social-auth-client'
const mockClientSecret = 'mock-social-auth-secret'

export type AnySocialAuthProvider = OAuthProvider<
	SocialAuthProfile,
	SocialAuthProviderName
>

function createConfiguredSocialAuthProvider(input: {
	provider: SocialAuthProviderName
	clientId: string
	clientSecret: string
	redirectUri: URL
}): AnySocialAuthProvider {
	if (input.provider === 'github') {
		return createGitHubAuthProvider({
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			redirectUri: input.redirectUri,
		}) as AnySocialAuthProvider
	}

	if (input.provider === 'google') {
		return createGoogleAuthProvider({
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			redirectUri: input.redirectUri,
		}) as AnySocialAuthProvider
	}

	return createXAuthProvider({
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		redirectUri: input.redirectUri,
	}) as AnySocialAuthProvider
}

function readProviderCredentials(env: Env, provider: SocialAuthProviderName) {
	if (provider === 'github') {
		return {
			clientId: env.GITHUB_CLIENT_ID?.trim(),
			clientSecret: env.GITHUB_CLIENT_SECRET?.trim(),
		}
	}
	if (provider === 'google') {
		return {
			clientId: env.GOOGLE_CLIENT_ID?.trim(),
			clientSecret: env.GOOGLE_CLIENT_SECRET?.trim(),
		}
	}
	return {
		clientId: env.X_CLIENT_ID?.trim(),
		clientSecret: env.X_CLIENT_SECRET?.trim(),
	}
}

export function createSocialAuthProvider(
	env: Env,
	provider: SocialAuthProviderName,
	requestUrl: string | URL,
): AnySocialAuthProvider | null {
	const origin = new URL(requestUrl).origin
	const redirectUri = new URL(
		`${getSocialAuthStartPath(provider)}/callback`,
		origin,
	)

	let clientId: string | undefined
	let clientSecret: string | undefined

	if (isSocialAuthMockEnabled(env)) {
		clientId = mockClientId
		clientSecret = mockClientSecret
	} else {
		;({ clientId, clientSecret } = readProviderCredentials(env, provider))
	}

	if (!clientId || !clientSecret) return null

	return createConfiguredSocialAuthProvider({
		provider,
		clientId,
		clientSecret,
		redirectUri,
	})
}
