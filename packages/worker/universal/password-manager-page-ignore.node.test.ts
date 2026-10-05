import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import {
	passwordManagerPageIgnoreAttribute,
	passwordManagerPageIgnoreProps,
	pathnameFromAppUrl,
	shouldIgnorePasswordManagerPage,
} from './password-manager-page-ignore.ts'

test('account shell pages ignore 1Password and signed-out auth pages do not', () => {
	expect(shouldIgnorePasswordManagerPage('/account')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/account/billing')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/account/two-factor')).toBe(true)
	expect(
		shouldIgnorePasswordManagerPage('/account/packages/pkg/files/readme.md'),
	).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/admin')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/admin/users')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/pending-verification')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/@jane/helper/approve-publish')).toBe(
		true,
	)
	expect(shouldIgnorePasswordManagerPage('/@jane/helper/approve-changes')).toBe(
		true,
	)

	expect(shouldIgnorePasswordManagerPage('/login')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/signup')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/reset-password')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/verify')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/verify-email')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/oauth/authorize')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/onboarding')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/@jane')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/@jane/helper')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/connect/secrets')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/docs')).toBe(false)
})

test('document urls keep only the pathname', () => {
	expect(pathnameFromAppUrl('/account?tab=security#former')).toBe('/account')
	expect(pathnameFromAppUrl('/login')).toBe('/login')
	expect(pathnameFromAppUrl(undefined)).toBe('/')
})

test('body markup carries data-1p-ignore only on account shell pages', async () => {
	const accountHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/account'),
			children: 'Account',
		}),
	)
	expect(accountHtml).toContain(passwordManagerPageIgnoreAttribute)
	expect(accountHtml).toContain('<body')

	const loginHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/login'),
			children: 'Login',
		}),
	)
	expect(loginHtml).not.toContain(passwordManagerPageIgnoreAttribute)
	expect(loginHtml).toContain('<body')
})
