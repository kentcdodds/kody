import { expect, test } from 'vitest'
import { buildCredentialPatternCheck } from './credential-pattern-check.ts'

const hintsHeading =
	'Optional, if you want a scoped credential type for these (ADR 0068):'
const injectHint =
	"- Header, query, or basic auth placeholders: a Key with an inject (credentialUpdate) can be opened with credential(key), and its client places the value and sends it only to the Key's hosts."
const oauthHint =
	'- Integration token headers: credential(key) for an OAuth connection sends Authorization: Bearer and refreshes the token for you.'
const loginHint =
	'- Password or token exchange bodies: a login credential (secretSet kind "login") runs the exchange on the host and places the session token.'

function manifest(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@kody/hints',
		exports: { '.': './src/index.ts' },
		kody: { id: 'hints', description: 'Hints test.', ...kody },
	})
}

function message(source: string, kody: Record<string, unknown> = {}) {
	return buildCredentialPatternCheck({
		'package.json': manifest(kody),
		'src/index.ts': source,
	}).message
}

function hintLines(text: string) {
	const lines = text.split('\n')
	const index = lines.indexOf(hintsHeading)
	return index === -1 ? [] : lines.slice(index)
}

test('oauth hints are only Authorization Bearer integration headers', () => {
	const otherShapes = message(
		"export const send = () => fetch('https://api.example.com', { headers: { 'X-Token': '{{integration-token:github}}', Authorization: 'Token {{integration-token:gitlab}}', 'X-Api-Key': '{{secret:KEY}}' } })",
	)
	expect(otherShapes).toContain('- src/index.ts: literal secret')
	expect(hintLines(otherShapes)).toEqual([hintsHeading, injectHint])
	expect(otherShapes).not.toMatch(/github|gitlab|KEY/)

	const schemeOnly = message(
		"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'bearer {{integration-token:github}}' } })",
	)
	expect(schemeOnly).toContain('literal secret')
	expect(hintLines(schemeOnly)).toEqual([])

	const valueOnly = message(
		"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: '{{integration-token:github}}' } })",
	)
	expect(hintLines(valueOnly)).toEqual([])

	const bearer = message(
		"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{integration-token:github}}', 'X-Token': '{{integration-token:github}}' } })",
	)
	expect(hintLines(bearer)).toEqual([hintsHeading, oauthHint])
})

test('secret-basic pairs do not get an inject hint', () => {
	const pair = message(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Basic {{secret-basic:username=USER,password=PASS}}' } })",
	)
	expect(pair).toContain('- src/index.ts: literal secret')
	expect(hintLines(pair)).toEqual([])
	expect(pair).not.toMatch(/USER|PASS/)

	const oneSecret = message(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Basic {{secret:PASSWORD}}' } })",
	)
	expect(hintLines(oneSecret)).toEqual([hintsHeading, injectHint])
})

test('login hints require an exchange endpoint and an exact credential field', () => {
	const compass = message(
		"export const login = () => fetch('https://api.example.com/login', { method: 'POST', body: JSON.stringify({ compass: '{{secret:NEEDLE}}' }) })",
	)
	expect(compass).toContain('literal secret')
	expect(hintLines(compass)).toEqual([])

	const passwordReset = message(
		"export const login = () => fetch('https://api.example.com/login', { method: 'POST', body: JSON.stringify({ passwordReset: '{{secret:NEXT}}' }) })",
	)
	expect(hintLines(passwordReset)).toEqual([])

	const changePassword = message(
		"export const change = () => fetch('https://api.example.com/change-password', { method: 'POST', body: JSON.stringify({ password: '{{secret:NEW_PASSWORD}}' }) })",
	)
	expect(changePassword).toContain('literal secret')
	expect(hintLines(changePassword)).toEqual([])

	const usernameOnly = message(
		"export const login = () => fetch('https://api.example.com/login', { method: 'POST', body: JSON.stringify({ username: '{{secret:USER}}' }) })",
	)
	expect(hintLines(usernameOnly)).toEqual([])

	const unknownEndpoint = message(
		"export const body = JSON.stringify({ password: '{{secret:ACCOUNT_PASSWORD}}' })",
	)
	expect(unknownEndpoint).toContain('literal secret')
	expect(hintLines(unknownEndpoint)).toEqual([])

	const exchange = message(
		"export const login = () => fetch('https://api.example.com/oauth/token', { method: 'POST', body: JSON.stringify({ pass: '{{secret:PASSWORD}}', refreshToken: '{{secret:REFRESH}}', client_secret: '{{secret:CLIENT}}' }) })",
	)
	expect(hintLines(exchange)).toEqual([hintsHeading, loginHint])
	expect(exchange).not.toMatch(/PASSWORD|REFRESH|CLIENT/)
})

test('hints skip placeholders a declared slot of the same kind already covers', () => {
	const covered = message(
		[
			"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN}}' } })",
			"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{integration-token:github}}' } })",
		].join('\n'),
		{
			secretMounts: { token: { name: 'MOUNTED' } },
			credentials: {
				TOKEN: { kind: 'secret', provider: 'api', description: 'API token.' },
				github: { kind: 'oauth', provider: 'github', description: 'GitHub.' },
			},
		},
	)
	expect(covered).toContain('- package.json: secretMounts')
	expect(covered).not.toContain('literal secret')
	expect(hintLines(covered)).toEqual([])
	expect(covered).not.toMatch(/TOKEN|github|MOUNTED/)

	const scoped = message(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN|scope=user}}' } })",
		{
			credentials: {
				TOKEN: { kind: 'secret', description: 'API token.' },
			},
		},
	)
	expect(scoped).toContain('- src/index.ts: |scope=')
	expect(hintLines(scoped)).toEqual([])

	const missingDescription = message(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN}}', 'X-Api-Key': '{{secret:OTHER}}' } })",
		{ credentials: { TOKEN: { kind: 'secret' } } },
	)
	expect(missingDescription).toContain('literal secret')
	expect(hintLines(missingDescription)).toEqual([hintsHeading, injectHint])
	expect(missingDescription).not.toMatch(/TOKEN|OTHER/)

	const wrongKind = message(
		"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{integration-token:github}}' } })",
		{
			credentials: {
				github: {
					kind: 'secret',
					description: 'A key, not an OAuth connection.',
				},
			},
		},
	)
	expect(hintLines(wrongKind)).toEqual([hintsHeading, oauthHint])

	const urlSlot = message(
		"export const send = () => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:HOOK}}' } })",
		{
			credentials: {
				HOOK: { kind: 'url', description: 'Hook URL.' },
			},
		},
	)
	expect(hintLines(urlSlot)).toEqual([hintsHeading, injectHint])
})
