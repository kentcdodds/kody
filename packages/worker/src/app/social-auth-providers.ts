import {
	socialAuthProviderNames,
	type SocialAuthProviderName,
} from '#app/social-auth-provider-names.ts'

export { type SocialAuthProviderName, socialAuthProviderNames }

export type SocialAuthProviderListItem = {
	id: SocialAuthProviderName
	label: string
	startPath: string
}

const providerLabels: Record<SocialAuthProviderName, string> = {
	github: 'GitHub',
	google: 'Google',
	x: 'X',
}

export function getSocialAuthStartPath(provider: SocialAuthProviderName) {
	return `/auth/${provider}`
}

export function isSocialAuthProviderName(
	value: string,
): value is SocialAuthProviderName {
	return (socialAuthProviderNames as ReadonlyArray<string>).includes(value)
}

export function isSocialAuthMockEnabled(env: Env) {
	return (
		env.SOCIAL_AUTH_MOCK === '1' ||
		(env as { SENTRY_ENVIRONMENT?: string }).SENTRY_ENVIRONMENT === 'test'
	)
}

function readOptionalSecret(value: string | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function providerConfigured(
	clientId: string | undefined,
	clientSecret: string | undefined,
) {
	return clientId != null && clientSecret != null
}

export function listConfiguredSocialAuthProviders(
	env: Env,
): Array<SocialAuthProviderListItem> {
	if (isSocialAuthMockEnabled(env)) {
		return socialAuthProviderNames.map((id) => ({
			id,
			label: providerLabels[id],
			startPath: getSocialAuthStartPath(id),
		}))
	}

	const providers: Array<SocialAuthProviderListItem> = []

	if (
		providerConfigured(
			readOptionalSecret(env.GITHUB_CLIENT_ID),
			readOptionalSecret(env.GITHUB_CLIENT_SECRET),
		)
	) {
		providers.push({
			id: 'github',
			label: providerLabels.github,
			startPath: getSocialAuthStartPath('github'),
		})
	}

	if (
		providerConfigured(
			readOptionalSecret(env.GOOGLE_CLIENT_ID),
			readOptionalSecret(env.GOOGLE_CLIENT_SECRET),
		)
	) {
		providers.push({
			id: 'google',
			label: providerLabels.google,
			startPath: getSocialAuthStartPath('google'),
		})
	}

	if (
		providerConfigured(
			readOptionalSecret(env.X_CLIENT_ID),
			readOptionalSecret(env.X_CLIENT_SECRET),
		)
	) {
		providers.push({
			id: 'x',
			label: providerLabels.x,
			startPath: getSocialAuthStartPath('x'),
		})
	}

	return providers
}

export function isSocialAuthProviderConfigured(
	env: Env,
	provider: SocialAuthProviderName,
) {
	return listConfiguredSocialAuthProviders(env).some(
		(item) => item.id === provider,
	)
}
