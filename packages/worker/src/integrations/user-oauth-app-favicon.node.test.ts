import { expect, test } from 'vitest'
import {
	assertHttpsPublicUrl,
	extractPngFromIco,
	parseHtmlIconCandidates,
	resolveFaviconOrigin,
	shouldFetchUserOauthAppFavicon,
} from './user-oauth-app-favicon.ts'
import { type UserOauthApp } from './types.ts'

test('resolveFaviconOrigin prefers authorizeUrl registrable domain', () => {
	const resolved = resolveFaviconOrigin([
		'https://accounts.google.com/o/oauth2/v2/auth',
		'https://www.googleapis.com',
		'https://oauth2.googleapis.com/token',
	])
	expect(resolved?.host).toBe('google.com')
	expect(resolved?.origin.href).toBe('https://google.com/')
})

test('resolveFaviconOrigin skips http and private hosts', () => {
	expect(
		resolveFaviconOrigin([
			'http://dropbox.com/oauth2/authorize',
			'https://localhost/token',
			'https://www.dropbox.com/oauth2/authorize',
		])?.host,
	).toBe('dropbox.com')
})

test('assertHttpsPublicUrl rejects credentials and localhost', () => {
	expect(() => assertHttpsPublicUrl('http://example.com/icon.png')).toThrow(
		/https/,
	)
	expect(() =>
		assertHttpsPublicUrl('https://user:pass@example.com/icon.png'),
	).toThrow(/credentials/)
	expect(() => assertHttpsPublicUrl('https://127.0.0.1/icon.png')).toThrow(
		/public/,
	)
	expect(() =>
		assertHttpsPublicUrl('https://169.254.169.254/latest/meta-data'),
	).toThrow(/public/)
	expect(() => assertHttpsPublicUrl('https://[::1]/icon.png')).toThrow(/public/)
})

test('parseHtmlIconCandidates ranks apple-touch-icon then larger icons', () => {
	const html = `
		<link rel="icon" href="/favicon-16.png" sizes="16x16">
		<link rel="apple-touch-icon" href="/apple-180.png" sizes="180x180">
		<link rel="icon" href="https://cdn.example.com/favicon.svg">
	`
	const candidates = parseHtmlIconCandidates(
		html,
		new URL('https://example.com/'),
	)
	expect(candidates.map((candidate) => candidate.href)).toEqual([
		'https://example.com/apple-180.png',
		'https://example.com/favicon-16.png',
		'https://cdn.example.com/favicon.svg',
	])
})

test('shouldFetchUserOauthAppFavicon skips explicit uploads and stale-host refetches', () => {
	const base: UserOauthApp = {
		userId: 'user-1',
		slug: 'dropbox',
		provider: 'dropbox',
		label: null,
		clientId: 'client',
		clientSecretSecretName: null,
		tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
		authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
		apiBaseUrl: 'https://api.dropboxapi.com/2',
		flow: 'pkce',
		usePkce: null,
		tokenExchangeStyle: null,
		scopeSeparator: null,
		extraAuthorizeParams: {},
		logoKey: null,
		logoContentType: null,
		logoSource: null,
		faviconSourceHost: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
	expect(shouldFetchUserOauthAppFavicon(base)).toBe(true)
	expect(
		shouldFetchUserOauthAppFavicon({
			...base,
			logoKey: 'user-oauth-app-logos/u/dropbox/abc.png',
			logoSource: 'upload',
		}),
	).toBe(false)
	expect(
		shouldFetchUserOauthAppFavicon({
			...base,
			logoKey: 'user-oauth-app-logos/u/dropbox/abc.png',
			logoSource: 'favicon',
			faviconSourceHost: 'dropbox.com',
		}),
	).toBe(false)
	expect(
		shouldFetchUserOauthAppFavicon({
			...base,
			logoKey: 'user-oauth-app-logos/u/dropbox/abc.png',
			logoSource: 'favicon',
			faviconSourceHost: 'old.example',
		}),
	).toBe(true)
})

test('extractPngFromIco returns the largest embedded PNG and skips BMP ICO', () => {
	const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const header = new Uint8Array(6 + 16)
	const view = new DataView(header.buffer)
	view.setUint16(0, 0, true)
	view.setUint16(2, 1, true)
	view.setUint16(4, 1, true)
	view.setUint32(6 + 8, png.byteLength, true)
	view.setUint32(6 + 12, header.byteLength, true)
	const ico = new Uint8Array(header.byteLength + png.byteLength)
	ico.set(header)
	ico.set(png, header.byteLength)
	expect(extractPngFromIco(ico)).toEqual(png)
	expect(extractPngFromIco(new Uint8Array([0, 0, 1, 0, 0, 0]))).toBeNull()
})
