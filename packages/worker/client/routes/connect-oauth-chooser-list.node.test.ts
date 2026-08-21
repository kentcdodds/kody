import { expect, test } from 'vitest'
import {
	connectOauthChooserFilterMinOptions,
	connectOauthChooserListMaxHeight,
	filterConnectOauthChooserOptions,
} from './connect-oauth-chooser-list.ts'

test('connect chooser filter matches label, detail, and provider key and stays hidden at six options', () => {
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

	expect(connectOauthChooserFilterMinOptions).toBe(6)
	expect(connectOauthChooserListMaxHeight).toContain('2.5 *')
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
