import { expect, test } from 'vitest'
import { filterConnectOauthChooserOptions } from './connect-oauth-chooser-list.ts'

test('connect chooser filter matches label, detail, and provider key', () => {
	const options = [
		{
			label: 'Google',
			detail: "Connect with Kody's built-in app",
			providerKey: 'google',
		},
		{
			label: 'GitHub work',
			detail: 'Reconnect this built-in account',
			providerKey: 'github',
		},
		{
			label: 'Notion',
			detail: 'Reconnect your OAuth app',
			providerKey: 'notion',
		},
	]

	expect(filterConnectOauthChooserOptions(options, '')).toEqual(options)
	expect(filterConnectOauthChooserOptions(options, '  built-in  ')).toEqual([
		options[0],
		options[1],
	])
	expect(filterConnectOauthChooserOptions(options, 'GITHUB')).toEqual([
		options[1],
	])
	expect(filterConnectOauthChooserOptions(options, 'notion oauth')).toEqual([
		options[2],
	])
	expect(filterConnectOauthChooserOptions(options, 'slack')).toEqual([])
})
