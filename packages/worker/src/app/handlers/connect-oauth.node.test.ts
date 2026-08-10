import { expect, test } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createConnectOauthHandler,
	isBareConnectOauthVisit,
} from '#app/handlers/connect-oauth.ts'

test('bare /connect/oauth visits redirect to the OAuth guide', async () => {
	const env = {} as Env
	const response = await createConnectOauthHandler(env).handler(
		new RequestContext(new Request('https://example.com/connect/oauth')),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toBe(
		'https://example.com/guides/oauth',
	)
})

test('provider, callback, and denial visits are not bare', () => {
	const bare = (search: string) =>
		isBareConnectOauthVisit(
			new URL(`https://example.com/connect/oauth${search}`),
		)
	expect(bare('')).toBe(true)
	expect(bare('?state=abc')).toBe(true)
	// Agent-built setup URLs and built-in connects.
	expect(bare('?provider=github')).toBe(false)
	// The provider's success redirect strips the config query; sessionStorage
	// restores it client-side.
	expect(bare('?code=auth-code&state=abc')).toBe(false)
	// The provider's denial redirect carries error instead of code.
	expect(bare('?error=access_denied&state=abc')).toBe(false)
})

test('anonymous visits with a provider still hit the session gate', async () => {
	const env = {} as Env
	const response = await createConnectOauthHandler(env).handler(
		new RequestContext(
			new Request('https://example.com/connect/oauth?provider=github'),
		),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('location')).toContain('/login')
})
