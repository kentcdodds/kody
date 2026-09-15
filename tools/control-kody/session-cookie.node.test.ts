import { expect, test } from 'vitest'
import {
	cookieHeaderForOrigin,
	formatCookieFile,
	looksLikeLoginHtml,
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
	expect(
		shouldRefreshSession({
			skipLogin: false,
			status: 200,
			path: '/account/values.json',
			rawBody: loginHtml,
			method: 'POST',
		}),
	).toBe(false)
})
