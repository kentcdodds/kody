import { expect, test } from 'vitest'
import { filterConnectOauthChooserOptions } from './connect-oauth-chooser-list.ts'

test('connect chooser filter matches label, detail, and provider key', () => {
	const options = [
		{
			label: 'Google',
			detail: 'Set up your own OAuth app to reconnect',
			providerKey: 'google',
		},
		{
			label: 'GitHub work',
			detail: 'Reconnect your OAuth app',
			providerKey: 'github',
		},
		{
			label: 'Notion',
			detail: 'Reconnect your OAuth app',
			providerKey: 'notion',
		},
	]

	expect(filterConnectOauthChooserOptions(options, '')).toEqual(options)
	expect(filterConnectOauthChooserOptions(options, '  set up  ')).toEqual([
		options[0],
	])
	expect(filterConnectOauthChooserOptions(options, 'GITHUB')).toEqual([
		options[1],
	])
	expect(filterConnectOauthChooserOptions(options, 'notion oauth')).toEqual([
		options[2],
	])
	expect(filterConnectOauthChooserOptions(options, 'slack')).toEqual([])
})
