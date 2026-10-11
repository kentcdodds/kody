import { expect, test } from 'vitest'
import {
	cookieHeaderForOrigin,
	formatCookieFile,
	looksLikeLoginHtml,
	mcpAuthForOrg,
	sessionForOrigin,
	shouldRefreshSession,
} from './session-cookie.ts'

const loginHtml =
	'<link rel="canonical" href="https://kody-pr-2338.example/login" data-kody-head="canonical" />'

test('cookie files are bound to one origin', () => {
	const file = formatCookieFile(
		'https://kody-pr-2338.example/',
		'kody_session=preview',
	)
	expect(cookieHeaderForOrigin(file, 'https://kody-pr-2338.example')).toBe(
		'kody_session=preview',
	)
	expect(cookieHeaderForOrigin(file, 'http://localhost:3742')).toBe(null)
	expect(
		cookieHeaderForOrigin('kody_session=legacy\n', 'http://localhost:3742'),
	).toBe(null)
})

test('cookie files are bound to origin plus email when --email is used', () => {
	const file = formatCookieFile(
		'http://localhost:3742',
		'kody_session=admin',
		'kody@example.com',
	)
	expect(
		cookieHeaderForOrigin(file, 'http://localhost:3742', 'kody@example.com'),
	).toBe('kody_session=admin')
	expect(
		cookieHeaderForOrigin(file, 'http://localhost:3742', 'jane@example.com'),
	).toBe(null)
	expect(
		cookieHeaderForOrigin(
			formatCookieFile('http://localhost:3742', 'kody_session=legacy'),
			'http://localhost:3742',
			'jane@example.com',
		),
	).toBe(null)
})

test('cookie files persist OAuth client and bearer token for MCP reuse', () => {
	const oauth = {
		clientId: 'client-1',
		clientSecret: 'secret-1',
		redirectUri: 'http://127.0.0.1/oauth/callback',
		accessToken: 'token-1',
	}
	const file = formatCookieFile(
		'https://kody-pr-9.example',
		'kody_session=preview',
		'me@kentcdodds.com',
		oauth,
	)
	expect(
		cookieHeaderForOrigin(
			file,
			'https://kody-pr-9.example',
			'me@kentcdodds.com',
		),
	).toBe('kody_session=preview')
	expect(
		sessionForOrigin(file, 'https://kody-pr-9.example', 'me@kentcdodds.com'),
	).toMatchObject({
		cookieHeader: 'kody_session=preview',
		oauth,
	})
	expect(
		sessionForOrigin(file, 'https://kody-pr-9.example', 'other@x.com'),
	).toBe(null)
})

test('OAuth cache is keyed by org so a different --org does not reuse the token', () => {
	const oauth = {
		clientId: 'client-1',
		clientSecret: 'secret-1',
		redirectUri: 'http://127.0.0.1/oauth/callback',
		accessToken: 'token-team',
	}
	const origin = 'https://kody-pr-9.example'
	const email = 'me@kentcdodds.com'
	const team = formatCookieFile(
		origin,
		'kody_session=preview',
		email,
		oauth,
		'@X-Org',
	)
	expect(team).toContain('# org=x-org')
	expect(sessionForOrigin(team, origin, email, 'x-org')).toMatchObject({
		org: 'x-org',
		oauth,
	})
	expect(sessionForOrigin(team, origin, email, '@x-org')?.oauth).toEqual(oauth)
	expect(sessionForOrigin(team, origin, email, 'other-org')).toBe(null)
	expect(sessionForOrigin(team, origin, email, null)).toBe(null)
	// request and browse still reuse the login cookie across orgs
	expect(cookieHeaderForOrigin(team, origin, email)).toBe(
		'kody_session=preview',
	)

	const personal = formatCookieFile(origin, 'kody_session=preview', email, {
		...oauth,
		accessToken: 'token-personal',
	})
	expect(personal).not.toContain('# org=')
	expect(
		sessionForOrigin(personal, origin, email, null)?.oauth?.accessToken,
	).toBe('token-personal')
	expect(sessionForOrigin(personal, origin, email, 'x-org')).toBe(null)

	expect(mcpAuthForOrg(team, origin, email, 'x-org')).toEqual({
		cookieHeader: 'kody_session=preview',
		oauth,
		orgSlug: 'x-org',
	})
	expect(mcpAuthForOrg(team, origin, email, 'other-org')).toEqual({
		cookieHeader: 'kody_session=preview',
		orgSlug: 'other-org',
	})
	expect(mcpAuthForOrg(team, origin, email, null)).toEqual({
		cookieHeader: 'kody_session=preview',
	})
	expect(mcpAuthForOrg(personal, origin, email, null)).toEqual({
		cookieHeader: 'kody_session=preview',
		oauth: { ...oauth, accessToken: 'token-personal' },
	})
	expect(mcpAuthForOrg(personal, origin, email, '@X-Org')).toEqual({
		cookieHeader: 'kody_session=preview',
		orgSlug: 'x-org',
	})
	expect(mcpAuthForOrg(null, origin, email, 'x-org')).toEqual({
		orgSlug: 'x-org',
	})
})

test('login HTML on an account path refreshes the session', () => {
	expect(looksLikeLoginHtml(loginHtml)).toBe(true)
	expect(
		shouldRefreshSession({
			skipLogin: false,
			status: 200,
			path: '/account/waiting',
			rawBody: loginHtml,
		}),
	).toBe(true)
	expect(
		shouldRefreshSession({
			skipLogin: false,
			status: 200,
			path: '/login',
			rawBody: loginHtml,
		}),
	).toBe(false)
	expect(
		shouldRefreshSession({
			skipLogin: false,
			status: 401,
			path: '/account/waiting.json',
			rawBody: '{"ok":false}',
		}),
	).toBe(true)
	expect(
		shouldRefreshSession({
			skipLogin: false,
			status: 200,
			path: '/account/values.json',
			rawBody: loginHtml,
			method: 'POST',
		}),
	).toBe(true)
})

test('a login nav link on a real account page does not refresh the session', () => {
	const waitingHtml = [
		'<link rel="canonical" href="https://kody-pr-2338.example/account/waiting" data-kody-head="canonical" />',
		'<a href="https://kody-pr-2338.example/login">Sign in</a>',
	].join('')
	expect(looksLikeLoginHtml(waitingHtml)).toBe(false)
	expect(
		shouldRefreshSession({
			skipLogin: false,
			status: 200,
			path: '/account/waiting',
			rawBody: waitingHtml,
			method: 'GET',
		}),
	).toBe(false)
})
