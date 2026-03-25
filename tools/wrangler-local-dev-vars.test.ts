import { expect, test } from 'vitest'
import {
	collectLocalDevVars,
	getCliVarKeys,
} from './wrangler-local-dev-vars.ts'

test('getCliVarKeys reads separate and inline --var flags', () => {
	const keys = getCliVarKeys([
		'dev',
		'--var',
		'COOKIE_SECRET:abc',
		'--var=AI_MODE:mock',
		'--port',
		'8787',
	])

	expect(keys).toEqual(new Set(['COOKIE_SECRET', 'AI_MODE']))
})

test('collectLocalDevVars only returns non-empty values not already set on cli', () => {
	const vars = collectLocalDevVars(
		{
			COOKIE_SECRET: 'cookie-secret',
			AI_GATEWAY_ID: '',
			AI_MODE: 'mock',
			GITHUB_TOKEN: 'github-token',
			RESEND_API_KEY: undefined,
		},
		new Set(['AI_MODE']),
	)

	expect(vars).toEqual([['GITHUB_TOKEN', 'github-token']])
})
