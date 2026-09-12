import { expect, test } from 'vitest'
import { buildConnectOauthWhatsNextPrompt } from './connect-oauth-whats-next.ts'

test('post-OAuth whats-next prompt fills service and connection name', () => {
	expect(
		buildConnectOauthWhatsNextPrompt({
			service: 'google',
			connectionName: 'google-work',
		}),
	).toBe(
		'I just connected to google with google-work. What should we do next? Is there a community package we can fork or one we can build to make using this integration easier?',
	)
	expect(
		buildConnectOauthWhatsNextPrompt({
			service: 'github',
			connectionName: 'github',
		}),
	).toBe(
		'I just connected to github with github. What should we do next? Is there a community package we can fork or one we can build to make using this integration easier?',
	)
})
