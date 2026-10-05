import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import {
	passwordManagerPageIgnoreAttribute,
	passwordManagerPageIgnoreProps,
	pathnameFromAppUrl,
	shouldIgnorePasswordManagerPage,
} from './password-manager-page-ignore.ts'

test('only login and signup stay fillable for 1Password', () => {
	expect(shouldIgnorePasswordManagerPage('/login')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/signup')).toBe(false)

	expect(shouldIgnorePasswordManagerPage('/admin/users')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/admin')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/account')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/account/billing')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/account/two-factor')).toBe(true)
	expect(
		shouldIgnorePasswordManagerPage('/account/packages/pkg/files/readme.md'),
	).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/pending-verification')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/@jane/helper/approve-publish')).toBe(
		true,
	)
	expect(shouldIgnorePasswordManagerPage('/reset-password')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/verify')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/verify-email')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/oauth/authorize')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/onboarding')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/pricing')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/docs')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/connect/secrets')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/login/extra')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/signup/extra')).toBe(true)
})

test('document urls keep only the pathname', () => {
	expect(pathnameFromAppUrl('/admin/users?q=kent#row')).toBe('/admin/users')
	expect(pathnameFromAppUrl('/login')).toBe('/login')
	expect(pathnameFromAppUrl(undefined)).toBe('/')
})

test('body markup carries data-1p-ignore except on login and signup', async () => {
	const adminHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/admin/users'),
			children: 'Users',
		}),
	)
	expect(adminHtml).toContain('<body data-1p-ignore>')

	const accountHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/account'),
			children: 'Account',
		}),
	)
	expect(accountHtml).toContain(passwordManagerPageIgnoreAttribute)

	const loginHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/login'),
			children: 'Login',
		}),
	)
	expect(loginHtml).not.toContain(passwordManagerPageIgnoreAttribute)
	expect(loginHtml).toContain('<body>')

	const signupHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/signup'),
			children: 'Signup',
		}),
	)
	expect(signupHtml).not.toContain(passwordManagerPageIgnoreAttribute)
})
