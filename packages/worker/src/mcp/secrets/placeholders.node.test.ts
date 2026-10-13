import { expect, test } from 'vitest'
import {
	parseSecretNameOrPlaceholder,
	replaceSecretPlaceholders,
	replaceSecretPlaceholdersInFormUrlEncoded,
	replaceSecretPlaceholdersInJson,
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

test('replaceSecretPlaceholders fills top-level placeholders in one pass', () => {
	const replacements = new Map([
		['{{secret:token}}', 'token-value'],
		['{{secret:apiKey}}', 'api-key-value'],
		['{{integration-token:github}}', 'github-token'],
	])
	expect(
		replaceSecretPlaceholders(
			'Bearer {{secret:token}} key={{secret:apiKey}} tok={{integration-token:github}}',
			replacements,
		),
	).toBe('Bearer token-value key=api-key-value tok=github-token')
})

test('replaceSecretPlaceholders leaves nested placeholders in values literal', () => {
	// Both credentials are in the map (as when a request also references
	// apiKey elsewhere). Filling token must not expand the nested form.
	const replacements = new Map([
		['{{secret:token}}', '{{secret:apiKey}}'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	expect(
		replaceSecretPlaceholders('Bearer {{secret:token}}', replacements),
	).toBe('Bearer {{secret:apiKey}}')
	expect(
		replaceSecretPlaceholders(
			'A={{secret:token}} B={{secret:apiKey}}',
			replacements,
		),
	).toBe('A={{secret:apiKey}} B=api-key-value')
})

test('replaceSecretPlaceholders keeps dollar sequences in values literal', () => {
	const replacements = new Map([['{{secret:token}}', "pre-$&-$$-$1-$`-$'"]])
	expect(replaceSecretPlaceholders('x={{secret:token}}=y', replacements)).toBe(
		"x=pre-$&-$$-$1-$`-$'=y",
	)
})

test('replaceSecretPlaceholders prefers the longest matching placeholder', () => {
	const replacements = new Map([
		['{{secret:token}}', 'bare'],
		['{{secret:token|scope=user}}', 'scoped'],
		['Basic {{secret-basic:username=u,password=p}}', 'Basic encoded'],
		['{{secret-basic:username=u,password=p}}', 'encoded'],
	])
	expect(
		replaceSecretPlaceholders(
			'{{secret:token|scope=user}}/{{secret:token}}',
			replacements,
		),
	).toBe('scoped/bare')
	expect(
		replaceSecretPlaceholders(
			'Basic {{secret-basic:username=u,password=p}}',
			replacements,
		),
	).toBe('Basic encoded')
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

test('form, path, and JSON fills leave nested placeholders in values literal', () => {
	const nested = '{{secret:apiKey}}'
	const replacements = new Map([
		['{{secret:token}}', nested],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	expect(
		replaceSecretPlaceholdersInFormUrlEncoded(
			'token={{secret:token}}&key={{secret:apiKey}}',
			replacements,
		),
	).toBe('token=%7B%7Bsecret%3AapiKey%7D%7D&key=api-key-value')
	expect(
		replaceSecretPlaceholdersInPath('/v1/{{secret:token}}/x', replacements),
	).toBe('/v1/%7B%7Bsecret:apiKey%7D%7D/x')
	expect(
		replaceSecretPlaceholdersInJson(
			'{"token":"{{secret:token}}","key":"{{secret:apiKey}}"}',
			replacements,
		),
	).toBe('{"token":"{{secret:apiKey}}","key":"api-key-value"}')
})

test('buffered fill does not expand placeholder text that only appears inside a stored value', () => {
	// Mirror of the stream recombination cases: after a single pass, text that
	// looks like {{secret:apiKey}} but came from a value must stay literal even
	// when apiKey is also in the replacement map.
	const replacements = new Map([
		['{{secret:token}}', 'prefix-{{secret:apiKey}}'],
		['{{secret:apiKey}}', 'api-key-value'],
	])
	expect(replaceSecretPlaceholders('{{secret:token}}', replacements)).toBe(
		'prefix-{{secret:apiKey}}',
	)
	expect(
		replaceSecretPlaceholders(
			'A={{secret:token}} B={{secret:apiKey}}',
			replacements,
		),
	).toBe('A=prefix-{{secret:apiKey}} B=api-key-value')
})
