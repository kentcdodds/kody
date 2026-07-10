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
}

export const integrationProviderSuggestions: ReadonlyArray<IntegrationProviderSuggestion> =
	[
		{
			id: 'github',
			name: 'GitHub',
			tagline: 'Repos, issues, pull requests, notifications.',
			scopeHint:
				'reading and managing my repositories, issues, and pull requests',
		},
		{
			id: 'google',
			name: 'Google',
			tagline: 'Gmail, Calendar, Drive.',
			scopeHint: 'reading my Gmail, Calendar, and Drive data',
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
		},
	]

export function buildIntegrationSetupPrompt(
	provider: IntegrationProviderSuggestion,
) {
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
