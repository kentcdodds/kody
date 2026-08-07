import { expect, test } from 'vitest'
import {
	buildPlatformEmailAddress,
	getPlatformEmailDomain,
	getSystemEmailDomain,
} from './platform-address.ts'

test('getPlatformEmailDomain derives inbox.<hostname> from APP_BASE_URL', () => {
	expect(getPlatformEmailDomain({ APP_BASE_URL: 'https://heykody.dev' })).toBe(
		'inbox.heykody.dev',
	)
	expect(
		getPlatformEmailDomain({ APP_BASE_URL: 'https://Staging.Example.COM/' }),
	).toBe('inbox.staging.example.com')
	expect(getPlatformEmailDomain({})).toBeNull()
	expect(getPlatformEmailDomain({ APP_BASE_URL: 'not a url' })).toBeNull()
})

test('getPlatformEmailDomain prefers a valid USER_EMAIL_DOMAIN override', () => {
	expect(
		getPlatformEmailDomain({
			APP_BASE_URL: 'https://heykody.dev',
			USER_EMAIL_DOMAIN: 'Mail.Example.COM.',
		}),
	).toBe('mail.example.com')
	// The override works without APP_BASE_URL too.
	expect(
		getPlatformEmailDomain({ USER_EMAIL_DOMAIN: 'inbox.heykody.dev' }),
	).toBe('inbox.heykody.dev')
	// A malformed override falls back to the derived default.
	expect(
		getPlatformEmailDomain({
			APP_BASE_URL: 'https://heykody.dev',
			USER_EMAIL_DOMAIN: 'not a hostname',
		}),
	).toBe('inbox.heykody.dev')
	expect(getPlatformEmailDomain({ USER_EMAIL_DOMAIN: 'user@host' })).toBeNull()
})

test('getSystemEmailDomain prefers a valid SYSTEM_EMAIL_DOMAIN override', () => {
	// The migration lock: APP_BASE_URL moves to heykody.app but system mail
	// (kody@..., operator inboxes) stays on the verified heykody.dev zone.
	expect(
		getSystemEmailDomain({
			APP_BASE_URL: 'https://heykody.app',
			SYSTEM_EMAIL_DOMAIN: 'heykody.dev',
		}),
	).toBe('heykody.dev')
	expect(getSystemEmailDomain({ SYSTEM_EMAIL_DOMAIN: 'HeyKody.DEV.' })).toBe(
		'heykody.dev',
	)
	// Without the override the domain derives from APP_BASE_URL as before.
	expect(getSystemEmailDomain({ APP_BASE_URL: 'https://heykody.dev' })).toBe(
		'heykody.dev',
	)
	// A malformed override falls back to the derived default.
	expect(
		getSystemEmailDomain({
			APP_BASE_URL: 'https://heykody.dev',
			SYSTEM_EMAIL_DOMAIN: 'not a hostname',
		}),
	).toBe('heykody.dev')
	expect(getSystemEmailDomain({})).toBeNull()
})

test('buildPlatformEmailAddress normalizes the username', () => {
	expect(
		buildPlatformEmailAddress({
			username: ' KentCDodds ',
			domain: 'inbox.heykody.dev',
		}),
	).toBe('kentcdodds@inbox.heykody.dev')
})
