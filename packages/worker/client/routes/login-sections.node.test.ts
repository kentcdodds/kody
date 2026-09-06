import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderAuthForm, renderWaitingListForm } from './login-sections.tsx'

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
			showInviteSignup: false,
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
			showInviteSignup: true,
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

	const inviteHtml = await renderToString(
		renderAuthForm({
			...shared,
			status: 'error',
			message: 'Invite code is required.',
			isSignup: true,
			showInviteSignup: true,
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

test('waitlist errors associate first name and email and idle uses status', async () => {
	const errorHtml = await renderToString(
		renderWaitingListForm({
			...shared,
			status: 'error',
			message: 'First name and email are required.',
			onSubmit: () => {},
		}),
	)
	expect(errorHtml).toContain('role="alert"')
	expect(errorHtml).toMatch(/id="auth-first-name"[^>]*aria-invalid="true"/)
	expect(errorHtml).toMatch(
		/id="auth-waitlist-email"[^>]*aria-describedby="auth-form-status"/,
	)

	const idleHtml = await renderToString(
		renderWaitingListForm({
			...shared,
			status: 'idle',
			message: null,
			onSubmit: () => {},
		}),
	)
	expect(idleHtml).toContain('role="status"')
	expect(idleHtml).not.toMatch(/<input[^>]*aria-invalid/)
})
