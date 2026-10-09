import { expect, test } from 'vitest'
import { parseSecretNameOrPlaceholder } from './placeholders.ts'

test('parseSecretNameOrPlaceholder accepts bare names and opaque refs', () => {
	expect(parseSecretNameOrPlaceholder('apiToken', 'field')).toEqual({
		name: 'apiToken',
		scope: null,
	})
	expect(
		parseSecretNameOrPlaceholder('{{secret:apiToken|scope=user}}', 'field'),
	).toEqual({
		name: 'apiToken',
		scope: 'user',
	})
	expect(
		parseSecretNameOrPlaceholder(
			'{{secret:mountedKey|scope=package}}',
			'field',
		),
	).toEqual({
		name: 'mountedKey',
		scope: 'package',
	})
})

test('parseSecretNameOrPlaceholder rejects plaintext and malformed refs', () => {
	expect(() => parseSecretNameOrPlaceholder('', 'field')).toThrow(/required/i)
	expect(() => parseSecretNameOrPlaceholder('not a name', 'field')).toThrow(
		/saved secret name/,
	)
	expect(() =>
		parseSecretNameOrPlaceholder('{{secret:a}}{{secret:b}}', 'field'),
	).toThrow(/single/)
	expect(() =>
		parseSecretNameOrPlaceholder('sk live plaintext', 'field'),
	).toThrow(/saved secret name/)
})
