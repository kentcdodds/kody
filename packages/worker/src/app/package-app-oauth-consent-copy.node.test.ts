import { expect, test } from 'vitest'
import {
	packageAppOauthAppDomain,
	packageAppOauthClaimLabels,
} from '#app/package-app-oauth-consent-copy.ts'

test('packageAppOauthClaimLabels always includes profile claims', () => {
	expect(packageAppOauthClaimLabels(['profile'])).toEqual([
		'See your name, username, and avatar',
		'See your access level for this app',
	])
})

test('packageAppOauthClaimLabels adds email in plain words', () => {
	expect(packageAppOauthClaimLabels(['profile', 'email'])).toEqual([
		'See your name, username, and avatar',
		'See your access level for this app',
		'See your email address',
	])
})

test('packageAppOauthAppDomain reads the redirect host', () => {
	expect(
		packageAppOauthAppDomain('https://acme.kody.run/_kody/auth/callback'),
	).toBe('acme.kody.run')
	expect(packageAppOauthAppDomain('not-a-url')).toBeNull()
})
