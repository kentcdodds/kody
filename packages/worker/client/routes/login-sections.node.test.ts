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
			prefillInviteCode: '',
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

test('username and invite errors mark only those fields', async () => {
	const usernameHtml = await renderToString(
		renderAuthForm({
			...shared,
			status: 'error',
			message: 'Username is required.',
			isSignup: true,
			prefillInviteCode: '',
			submitLabel: 'Create account',
			submitBusyLabel: 'Creating…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)
	expect(usernameHtml).toMatch(/id="auth-username"[^>]*aria-invalid="true"/)
	expect(usernameHtml).toMatch(/id="auth-email"[^>]*autocomplete="email"/)
	expect(usernameHtml).not.toMatch(/id="auth-email"[^>]*aria-invalid/)
	expect(usernameHtml).toContain('Invite code')

	const inviteHtml = await renderToString(
		renderAuthForm({
			...shared,
			status: 'error',
			message: 'Invite code is invalid.',
			isSignup: true,
			prefillInviteCode: '',
			submitLabel: 'Create account',
			submitBusyLabel: 'Creating…',
			onSubmit: () => {},
			onPasskeySignIn: () => {},
		}),
	)
	expect(inviteHtml).toMatch(/id="auth-invite-code"[^>]*aria-invalid="true"/)
	expect(inviteHtml).not.toMatch(/id="auth-username"[^>]*aria-invalid/)
})
