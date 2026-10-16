import { expect, test } from 'vitest'
import {
	parsePackageAppOauthScopes,
	scopesIncludeEmail,
} from '#app/package-app-oauth-scopes.ts'

test('package-app OAuth scopes always include profile; email is opt-in', () => {
	expect(parsePackageAppOauthScopes(null)).toEqual({
		scopes: ['profile'],
		error: null,
	})
	expect(parsePackageAppOauthScopes('email')).toEqual({
		scopes: ['profile', 'email'],
		error: null,
	})
	expect(parsePackageAppOauthScopes('profile email')).toEqual({
		scopes: ['profile', 'email'],
		error: null,
	})
	expect(parsePackageAppOauthScopes('admin').error).toMatch(/Unsupported/)
	expect(scopesIncludeEmail(['profile', 'email'])).toBe(true)
	expect(scopesIncludeEmail(['profile'])).toBe(false)
})
