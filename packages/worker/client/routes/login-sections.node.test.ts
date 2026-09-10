import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderAuthForm } from './login-sections.tsx'

const shared = {
	handleId: 'auth',
	turnstileSiteKey: null,
	isSubmitting: false,
	onFieldEdit: () => {},
}

test('credential errors associate the status message with email and password', async () => {
	const html = await renderToString(
		renderAuthForm({
			...shared,
			status: 'error',
			message: 'Invalid email or password.',
			isSignup: false,
			submitLabel: 'Log in',
			submitBusyLabel: 'Logging in…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)

	expect(html).toContain('id="auth-form-status"')
	expect(html).toContain('role="alert"')
	expect(html).toMatch(/id="auth-email"[^>]*aria-invalid="true"/)
	expect(html).toMatch(/id="auth-password"[^>]*aria-invalid="true"/)
	expect(html).toMatch(
		/id="auth-email"[^>]*aria-describedby="auth-form-status"/,
	)
	expect(html).toMatch(/id="auth-email"[^>]*type="email"/)
	expect(html).toMatch(/id="auth-email"[^>]*autocomplete="username"/)
	expect(html).not.toContain('id="auth-username"')
})

test('username errors mark only that field', async () => {
	const usernameHtml = await renderToString(
		renderAuthForm({
			...shared,
			status: 'error',
			message: 'Username is required.',
			isSignup: true,
			submitLabel: 'Create account',
			submitBusyLabel: 'Creating…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)
	expect(usernameHtml).toMatch(/id="auth-username"[^>]*aria-invalid="true"/)
	expect(usernameHtml).toMatch(/id="auth-email"[^>]*autocomplete="email"/)
	expect(usernameHtml).not.toMatch(/id="auth-email"[^>]*aria-invalid/)
	expect(usernameHtml).not.toContain('Invite code')
})
