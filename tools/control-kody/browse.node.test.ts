import { expect, test } from 'vitest'
import {
	browseTargetUrl,
	defaultBrowsePath,
	formatBrowseReport,
	normalizeBrowsePath,
	openBrowseSession,
	playwrightCookiesFromHeader,
	type BrowseChromium,
} from './browse.ts'

test('playwrightCookiesFromHeader maps Cookie header for https preview origin', () => {
	expect(
		playwrightCookiesFromHeader(
			'kody_session=abc123; other=value',
			'https://kody-pr-9.kody.workers.dev/',
		),
	).toEqual([
		{
			name: 'kody_session',
			value: 'abc123',
			domain: 'kody-pr-9.kody.workers.dev',
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
		},
		{
			name: 'other',
			value: 'value',
			domain: 'kody-pr-9.kody.workers.dev',
			path: '/',
			httpOnly: false,
			secure: true,
			sameSite: 'Lax',
		},
	])
})

test('playwrightCookiesFromHeader uses insecure cookies for localhost', () => {
	expect(
		playwrightCookiesFromHeader('kody_session=local', 'http://127.0.0.1:3742'),
	).toEqual([
		{
			name: 'kody_session',
			value: 'local',
			domain: '127.0.0.1',
			path: '/',
			httpOnly: true,
			secure: false,
			sameSite: 'Lax',
		},
	])
})

test('normalizeBrowsePath rejects full URLs, protocol-relative paths, and backslashes', () => {
	expect(normalizeBrowsePath('')).toBe(defaultBrowsePath)
	expect(normalizeBrowsePath('  /account/packages  ')).toBe('/account/packages')
	expect(() => normalizeBrowsePath('account')).toThrow(/same-origin path/)
	expect(() =>
		normalizeBrowsePath('https://kody-pr-9.example/account'),
	).toThrow(/same-origin path/)
	expect(() => normalizeBrowsePath('//attacker.example/account')).toThrow(
		/same-origin path/,
	)
	expect(() => normalizeBrowsePath('/\\attacker.example')).toThrow(
		/backslashes/,
	)
})

test('browseTargetUrl joins origin and path and refuses host escape', () => {
	expect(browseTargetUrl('https://kody-pr-9.example/', '/@user/pkg')).toBe(
		'https://kody-pr-9.example/@user/pkg',
	)
	expect(() =>
		browseTargetUrl('https://kody-pr-9.example/', '//attacker.example/x'),
	).toThrow(/same-origin path/)
})

test('openBrowseSession injects cookies and opens the target path', async () => {
	const added: Array<unknown> = []
	const gotoCalls: Array<string> = []
	let disconnected: (() => void) | null = null
	const page = {
		goto: async (url: string) => {
			gotoCalls.push(url)
		},
		on: (_event: string, _listener: () => void) => {},
	}
	const context = {
		addCookies: async (cookies: Array<unknown>) => {
			added.push(...cookies)
		},
		newPage: async () => page,
		close: async () => {},
	}
	const browser = {
		newContext: async () => context,
		close: async () => {},
		on: (event: string, listener: () => void) => {
			if (event === 'disconnected') disconnected = listener
		},
		isConnected: () => true,
	}
	const fakeChromium: BrowseChromium = {
		launch: async () => browser as never,
	}

	const reportPromise = openBrowseSession({
		origin: 'https://kody-pr-9.example',
		path: '/account/packages/demo',
		cookieHeader: 'kody_session=seed',
		chromium: fakeChromium,
		closeAfterMs: 0,
	})
	const report = await reportPromise
	expect(added).toEqual([
		expect.objectContaining({
			name: 'kody_session',
			value: 'seed',
			domain: 'kody-pr-9.example',
			secure: true,
		}),
	])
	expect(gotoCalls).toEqual(['https://kody-pr-9.example/account/packages/demo'])
	expect(report).toMatchObject({
		ok: true,
		url: 'https://kody-pr-9.example/account/packages/demo',
		headed: true,
		record: false,
	})
	expect(formatBrowseReport(report)).toContain('signed in')
	expect(disconnected).toBeNull()
})

test('openBrowseSession refuses an empty cookie header', async () => {
	await expect(
		openBrowseSession({
			origin: 'http://localhost:3742',
			path: '/account',
			cookieHeader: '   ',
			chromium: {
				launch: async () => {
					throw new Error('should not launch')
				},
			},
		}),
	).rejects.toThrow(/session cookie/)
})
