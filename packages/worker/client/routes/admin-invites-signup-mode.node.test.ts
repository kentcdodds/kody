import { renderToString } from 'remix/ui/server'
import { expect, test, vi } from 'vitest'
import { type SignupModeSetting } from '#universal/signup-mode.ts'
import { createAdminInvitesSignupModePanel } from './admin-invites-signup-mode.tsx'

const loadedWaitlist: SignupModeSetting = {
	mode: 'waitlist',
	source: 'kv',
	envDefault: 'invite',
	updatedAt: '2026-09-02T00:00:00.000Z',
	updatedBy: 'admin-stable-id',
}

test('signup mode Save is disabled until the setting has loaded', async () => {
	const handle = { update: vi.fn() }
	const onSave = vi.fn()
	const onRetry = vi.fn()
	const panel = createAdminInvitesSignupModePanel(handle as never)

	const loadingHtml = await renderToString(
		panel.render({
			setting: null,
			disabled: false,
			saving: false,
			onSave,
		}),
	)
	expect(loadingHtml).toMatch(/<select[^>]*disabled/)
	expect(loadingHtml).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Save mode/)
	expect(loadingHtml).toContain('Loading…')
	expect(loadingHtml).not.toContain('Retry')

	const errorHtml = await renderToString(
		panel.render({
			setting: null,
			disabled: false,
			saving: false,
			onSave,
			onRetry,
		}),
	)
	expect(errorHtml).toMatch(/<select[^>]*disabled/)
	expect(errorHtml).toContain('Retry')
	expect(errorHtml).not.toMatch(/<button[^>]*>[\s\S]*Save mode/)

	const loadedHtml = await renderToString(
		panel.render({
			setting: loadedWaitlist,
			disabled: false,
			saving: false,
			onSave,
		}),
	)
	expect(loadedHtml).toContain('value="waitlist"')
	expect(loadedHtml).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Save mode/)
	expect(onSave).not.toHaveBeenCalled()
})
