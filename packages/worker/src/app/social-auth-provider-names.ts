export type SocialAuthProviderName = 'github' | 'google' | 'x'

export const socialAuthProviderNames = [
	'github',
	'google',
	'x',
] as const satisfies ReadonlyArray<SocialAuthProviderName>
