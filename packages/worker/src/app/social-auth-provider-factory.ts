import {
	createGitHubAuthProvider,
	createGoogleAuthProvider,
	createXAuthProvider,
	type OAuthProvider,
} from 'remix/auth'
import {
	getSocialAuthStartPath,
	isSocialAuthMockEnabled,
	type SocialAuthProviderName,
} from '#app/social-auth-providers.ts'

const mockClientId = 'mock-social-auth-client'
const mockClientSecret = 'mock-social-auth-secret'

export type AnySocialAuthProvider = OAuthProvider<unknown, string>

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

	if (isSocialAuthMockEnabled(env)) {
		return createConfiguredSocialAuthProvider({
			provider,
			clientId: mockClientId,
			clientSecret: mockClientSecret,
			redirectUri,
		})
	}

	if (provider === 'github') {
		const clientId = env.GITHUB_CLIENT_ID?.trim()
		const clientSecret = env.GITHUB_CLIENT_SECRET?.trim()
		if (!clientId || !clientSecret) return null
		return createGitHubAuthProvider({
			clientId,
			clientSecret,
			redirectUri,
		}) as AnySocialAuthProvider
	}

	if (provider === 'google') {
		const clientId = env.GOOGLE_CLIENT_ID?.trim()
		const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim()
		if (!clientId || !clientSecret) return null
		return createGoogleAuthProvider({
			clientId,
			clientSecret,
			redirectUri,
		}) as AnySocialAuthProvider
	}

	const clientId = env.X_CLIENT_ID?.trim()
	const clientSecret = env.X_CLIENT_SECRET?.trim()
	if (!clientId || !clientSecret) return null
	return createXAuthProvider({
		clientId,
		clientSecret,
		redirectUri,
	}) as AnySocialAuthProvider
}

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
