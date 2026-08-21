import { expect, test } from 'vitest'
import {
	buildConnectOauthChooserOptions,
	buildConnectOauthHref,
	isConnectOauthCallbackUrl,
} from './oauth-connect.ts'

test('connect chooser lists reconnectable connections and unused built-ins', () => {
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
			platform: true,
			appSlug: 'google',
		}),
	).toBe('/connect/oauth?provider=google&platform=google')

	const options = buildConnectOauthChooserOptions({
		connections: [
			{
				name: 'google-work',
				label: 'Work Google',
				providerKey: 'google',
				logoPath: null,
				platform: false,
				appSlug: 'google',
				canDrive: true,
			},
			{
				name: 'broken',
				label: 'Broken',
				providerKey: 'linear',
				logoPath: null,
				platform: false,
				appSlug: 'linear',
				canDrive: false,
			},
			{
				name: 'github',
				label: 'GitHub',
				providerKey: 'github',
				logoPath: '/integrations/logos/github',
				platform: true,
				appSlug: 'github',
				canDrive: true,
			},
		],
		platformApps: [
			{
				slug: 'github',
				label: 'GitHub',
				provider: 'github',
				logoPath: '/integrations/logos/github',
			},
			{
				slug: 'google',
				label: 'Google',
				provider: 'google',
				logoPath: null,
			},
			{
				slug: 'spotify',
				label: 'Spotify',
				provider: 'spotify',
				logoPath: null,
			},
		],
	})

	expect(options.map((option) => option.id)).toEqual([
		'connection:google-work',
		'connection:github',
		'platform:google',
		'platform:spotify',
	])
	expect(options[0]).toMatchObject({
		href: '/connect/oauth?provider=google-work&app=google',
		kind: 'connection',
	})
	expect(options[2]).toMatchObject({
		href: '/connect/oauth?provider=google&platform=google',
		kind: 'platform',
		detail: "Connect with Kody's built-in app",
	})
})
