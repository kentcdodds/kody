import { expect, test } from 'vitest'
import {
	buildPlatformEmailAddress,
	getPlatformEmailDomain,
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

test('buildPlatformEmailAddress normalizes the username', () => {
	expect(
		buildPlatformEmailAddress({
			username: ' KentCDodds ',
			domain: 'inbox.heykody.dev',
		}),
	).toBe('kentcdodds@inbox.heykody.dev')
})
