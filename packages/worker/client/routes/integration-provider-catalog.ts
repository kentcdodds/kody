/**
 * Suggested providers for the integrations page. Kody intentionally has no
 * built-in OAuth apps ("bring your own keys"), so each suggestion carries a
 * copyable prompt that asks the user's agent to walk them through creating
 * their own OAuth app and saving the integration in Kody.
 */
export type IntegrationProviderSuggestion = {
	id: string
	name: string
	tagline: string
	scopeHint: string
	/** Web slug for the bundled provider setup guide at `/guides/:slug`. */
	guideSlug?: string
}

export const integrationProviderSuggestions: ReadonlyArray<IntegrationProviderSuggestion> =
	[
		{
			id: 'github',
			name: 'GitHub',
			tagline: 'Repos, issues, pull requests, notifications.',
			scopeHint:
				'reading and managing my repositories, issues, and pull requests',
			guideSlug: 'github',
		},
		{
			id: 'google',
			name: 'Google',
			tagline: 'Gmail, Calendar, Drive.',
			scopeHint: 'reading my Gmail, Calendar, and Drive data',
			guideSlug: 'google',
		},
		{
			id: 'notion',
			name: 'Notion',
			tagline: 'Pages, databases, notes.',
			scopeHint: 'reading and updating my Notion pages',
			guideSlug: 'notion',
		},
		{
			id: 'slack',
			name: 'Slack',
			tagline: 'Messages, channels, reminders.',
			scopeHint: 'reading and sending messages in my workspace',
		},
		{
			id: 'spotify',
			name: 'Spotify',
			tagline: 'Playlists, playback, listening history.',
			scopeHint: 'managing my playlists and playback',
			guideSlug: 'spotify',
		},
		{
			id: 'x',
			name: 'X (Twitter)',
			tagline: 'Posts, bookmarks, timelines.',
			scopeHint: 'reading my timeline and posting on my behalf',
		},
		{
			id: 'discord',
			name: 'Discord',
			tagline: 'Servers, channels, messages.',
			scopeHint: 'reading and sending messages in my servers',
			guideSlug: 'discord',
		},
	]

export function buildIntegrationSetupPrompt(
	provider: IntegrationProviderSuggestion,
) {
	if (provider.guideSlug) {
		// The guide holds the verified console steps (and may lead with a
		// personal-token lane), so the prompt defers to it instead of
		// hardcoding an OAuth-app walkthrough.
		return [
			`Load the official Kody setup guide with coding_guide_get({ guide: 'provider_${provider.guideSlug}' }) and follow it to connect ${provider.name} to my Kody account.`,
			'First explain the plan in plain language.',
			`Then walk me through the guide's recommended path step by step, choose the minimal access for ${provider.scopeHint},`,
			'save the integration in Kody, and verify the connection with the guide\u2019s smoke test.',
		].join(' ')
	}
	return [
		`Help me connect ${provider.name} to my Kody account as an integration.`,
		'First explain the plan in plain language.',
		`Then walk me through creating my own OAuth app on ${provider.name} step by step,`,
		`choose the minimal scopes for ${provider.scopeHint},`,
		'save the integration in Kody, and finish the OAuth authorization flow.',
	].join(' ')
}

export function buildCustomIntegrationSetupPrompt() {
	return [
		'I want to connect a new service to my Kody account as an integration.',
		'Ask me which service, then walk me through creating my own OAuth app on',
		'that service, choosing minimal scopes, saving the integration in Kody,',
		'and completing the OAuth authorization flow.',
	].join(' ')
}
