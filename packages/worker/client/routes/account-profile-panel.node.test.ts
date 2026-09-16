import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderAccountProfilePanel } from './account-profile-panel.tsx'

function panelProps(
	overrides: Partial<Parameters<typeof renderAccountProfilePanel>[0]> = {},
) {
	return {
		email: 'jaimie@example.com',
		emailVerified: true,
		username: 'jklotz08',
		draftUsername: 'jklotz',
		draftDisplayName: 'Jaimie',
		draftBio: '',
		draftProfileVisibility: 'public' as const,
		draftEmail: 'jaimie@example.com',
		emailChangePassword: '',
		avatarUrl: null,
		avatarStatus: 'idle' as const,
		isSaving: false,
		isSendingEmailChange: false,
		profileUnchanged: false,
		normalizedDraftUsername: 'jklotz',
		normalizedDraftEmail: 'jaimie@example.com',
		emailChangeMessage: null,
		emailChangeTone: 'info' as const,
		emailChangeOpen: false,
		usernameFieldError: null,
		onProfileSubmit: () => undefined,
		onEmailChangeSubmit: () => undefined,
		onAvatarSelected: () => undefined,
		onRemoveAvatar: () => undefined,
		onDraftUsernameInput: () => undefined,
		onDraftDisplayNameChange: () => undefined,
		onDraftBioChange: () => undefined,
		onDraftProfileVisibilityChange: () => undefined,
		onDraftEmailInput: () => undefined,
		onEmailChangeToggle: () => undefined,
		onEmailChangePasswordInput: () => undefined,
		...overrides,
	}
}

test('profile panel keeps the typed username and shows a save error without success chrome', async () => {
	const html = await renderToString(
		jsx('div', {
			children: renderAccountProfilePanel(
				panelProps({
					usernameFieldError: '`jklotz` is taken.',
				}),
			),
		}),
	)

	expect(html).toContain('value="jklotz"')
	expect(html).toContain('data-testid="account-username-error"')
	expect(html).toContain('`jklotz` is taken.')
	expect(html).not.toContain('Profile saved.')
})

test('change-email disclosure stays open after a new-email keystroke remounts the panel', async () => {
	const closedHtml = await renderToString(
		jsx('div', {
			children: renderAccountProfilePanel(panelProps()),
		}),
	)
	const openHtml = await renderToString(
		jsx('div', {
			children: renderAccountProfilePanel(
				panelProps({
					emailChangeOpen: true,
					draftEmail: 'n',
					normalizedDraftEmail: 'n',
				}),
			),
		}),
	)

	expect(closedHtml).toContain('data-testid="account-change-email"')
	expect(closedHtml).not.toMatch(
		/<details[^>]*open[^>]*data-testid="account-change-email"/,
	)
	expect(openHtml).toMatch(
		/<details[^>]*open[^>]*data-testid="account-change-email"/,
	)
	expect(openHtml).toContain('id="account-new-email"')
	expect(openHtml).toContain('data-testid="account-new-email"')
	expect(openHtml).toContain('value="n"')
	expect(openHtml).toMatch(
		/<input[^>]*id="account-new-email"[^>]*autocomplete="off"/,
	)
})
