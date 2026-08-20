import { expect, test } from 'vitest'
import {
	getNewSecretQueryKey,
	getNewSecretValueAutofocusKey,
} from './new-secret-query.ts'

test('prefilled /new?name=... keys autofocus on the secret value', () => {
	expect(getNewSecretValueAutofocusKey('/account/secrets')).toBe('')
	expect(getNewSecretValueAutofocusKey('/account/secrets/new')).toBe('')
	expect(getNewSecretValueAutofocusKey('/account/secrets/new?name=%20')).toBe(
		'',
	)
	expect(
		getNewSecretValueAutofocusKey(
			'/account/secrets/new?description=Bot%20token&allowedHosts=discord.com',
		),
	).toBe('')

	const prefilled =
		'/account/secrets/new?name=discordBotTokenKodyOfficial&description=Discord%20bot%20token&allowedHosts=discord.com&scope=user'
	expect(getNewSecretValueAutofocusKey(prefilled)).toBe(
		getNewSecretQueryKey(prefilled),
	)
	expect(getNewSecretValueAutofocusKey(prefilled).length).toBeGreaterThan(0)
	expect(getNewSecretValueAutofocusKey(`${prefilled}&q=unrelated-filter`)).toBe(
		getNewSecretQueryKey(prefilled),
	)
})
