import { expect, test } from 'vitest'
import {
	buildConnectOauthChooserOptions,
	buildConnectOauthHref,
	isConnectOauthCallbackUrl,
} from './oauth-connect.ts'

test('connect chooser lists reconnectable connections and hides unused built-ins', () => {
	expect(
		isConnectOauthCallbackUrl(
			new URL('https://example.com/connect/oauth?code=abc&state=1'),
		),
	).toBe(true)
	expect(
		isConnectOauthCallbackUrl(
			new URL('https://example.com/connect/oauth?error=access_denied'),
		),
	).toBe(true)
	expect(
		isConnectOauthCallbackUrl(new URL('https://example.com/connect/oauth')),
	).toBe(false)
	expect(
		isConnectOauthCallbackUrl(
			new URL('https://example.com/connect/oauth?provider=google'),
		),
	).toBe(false)

	expect(
		buildConnectOauthHref({ name: 'google-work', appSlug: 'google' }),
	).toBe('/connect/oauth?provider=google-work&app=google')
	expect(
		buildConnectOauthHref({
			name: 'google',
			appSlug: 'google',
		}),
	).toBe('/connect/oauth?provider=google&app=google')

	const options = buildConnectOauthChooserOptions({
		connections: [
			{
				name: 'google-work',
				label: 'Work Google',
				providerKey: 'google',
				logoPath: null,
				autoLogoPath: null,
				platform: false,
				appSlug: 'google',
				canDrive: true,
			},
			{
				name: 'broken',
				label: 'Broken',
				providerKey: 'linear',
				logoPath: null,
				autoLogoPath: null,
				platform: false,
				appSlug: 'linear',
				canDrive: false,
			},
			{
				name: 'github',
				label: 'GitHub',
				providerKey: 'github',
				logoPath: '/integrations/logos/github',
				autoLogoPath: null,
				platform: true,
				appSlug: 'github',
				canDrive: true,
			},
		],
	})

	expect(options.map((option) => option.id)).toEqual([
		'connection:google-work',
		'connection:github',
	])
	expect(options[0]).toMatchObject({
		href: '/connect/oauth?provider=google-work&app=google',
		kind: 'connection',
		detail: 'Reconnect your OAuth app',
	})
	expect(options[1]).toMatchObject({
		href: '/connect/oauth?provider=github',
		kind: 'connection',
		detail: 'Set up your own OAuth app to reconnect',
	})
})
