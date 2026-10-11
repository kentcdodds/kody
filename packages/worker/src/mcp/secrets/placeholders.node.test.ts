import { expect, test } from 'vitest'
import {
	parseSecretNameOrPlaceholder,
	replaceSecretPlaceholdersInFormUrlEncoded,
	replaceSecretPlaceholdersInPath,
} from './placeholders.ts'

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

test('form fill re-encodes only the components that hold a placeholder', () => {
	const replacements = new Map([['{{secret:apiKey}}', 'k y&=+']])
	expect(
		replaceSecretPlaceholdersInFormUrlEncoded(
			'sig=a%20b&list=x+y&token={{secret:apiKey}}&enc=%7B%7Bsecret%3AapiKey%7D%7D&flag',
			replacements,
		),
	).toBe('sig=a%20b&list=x+y&token=k+y%26%3D%2B&enc=k+y%26%3D%2B&flag')
	expect(
		replaceSecretPlaceholdersInFormUrlEncoded('a=%20&b=c', replacements),
	).toBe('a=%20&b=c')
})

test('path fill encodes each value as segment data and finds encoded placeholders', () => {
	const replacements = new Map([
		['{{secret:token|scope=user}}', '../admin/x?y#z'],
		['{{secret:botToken}}', '123:ab@c'],
	])
	expect(
		replaceSecretPlaceholdersInPath(
			'/v1/bot{{secret:botToken}}/me%2Fkeep',
			replacements,
		),
	).toBe('/v1/bot123:ab@c/me%2Fkeep')
	expect(
		replaceSecretPlaceholdersInPath(
			'/v1/%7B%7Bsecret%3Atoken%7Cscope%3Duser%7D%7D/x',
			replacements,
		),
	).toBe('/v1/..%2Fadmin%2Fx%3Fy%23z/x')
	expect(
		replaceSecretPlaceholdersInPath('/v1/{{secret:other}}/x', replacements),
	).toBe('/v1/{{secret:other}}/x')
})

test('path fill matches a vault ref across its slash', () => {
	const replacements = new Map([['{{secret/onepassword:op://v/i/f}}', 't/k']])
	expect(
		replaceSecretPlaceholdersInPath(
			'/v1/{{secret/onepassword:op://v/i/f}}/me',
			replacements,
		),
	).toBe('/v1/t%2Fk/me')
	expect(
		replaceSecretPlaceholdersInPath(
			'/v1/%7B%7Bsecret/onepassword:op://v/i/f%7D%7D/me',
			replacements,
		),
	).toBe('/v1/t%2Fk/me')
})

test('path fill refuses a value that would form a dot segment', () => {
	expect(() =>
		replaceSecretPlaceholdersInPath(
			'/a/{{secret:dots}}/b',
			new Map([['{{secret:dots}}', '..']]),
		),
	).toThrow(/"\." or "\.\." segment/)
})
