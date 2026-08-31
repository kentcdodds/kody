import { css, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { queueSessionRefresh } from '#client/session.ts'
import { toast } from '#client/toast.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountDisclosureCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { minPasswordLength } from '@kody-internal/shared/password-policy.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

type PasswordStatus = 'idle' | 'saving'

export function AccountPasswordPanel(
	handle: Handle<{
		hasUsablePassword: boolean
		onPasswordSet: () => void
	}>,
) {
	let currentPassword = ''
	let newPassword = ''
	let confirmPassword = ''
	let status: PasswordStatus = 'idle'
	let message: string | null = null
	let messageTone: 'error' | 'info' = 'info'

	function updateCurrentPassword(event: Event) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		currentPassword = event.currentTarget.value
		handle.update()
	}

	function updateNewPassword(event: Event) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		newPassword = event.currentTarget.value
		handle.update()
	}

	function updateConfirmPassword(event: Event) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		confirmPassword = event.currentTarget.value
		handle.update()
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (handle.props.hasUsablePassword && !currentPassword) {
			message = 'Current password is required.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (!newPassword || !confirmPassword) {
			message = 'New password and confirmation are required.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (newPassword !== confirmPassword) {
			message = 'New password and confirmation do not match.'
			messageTone = 'error'
			handle.update()
			return
		}

		status = 'saving'
		message = null
		messageTone = 'info'
		handle.update()

		try {
			const response = await fetch(routes.accountPassword.href(), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					...(handle.props.hasUsablePassword ? { currentPassword } : {}),
					newPassword,
				}),
			})
			if (response.status === 401) {
				const payload = await readJson<{ code?: string; error?: string }>(
					response,
				)
				if (payload?.code === 'invalid_password') {
					throw new Error(payload.error)
				}
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok?: boolean
				message?: string
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update your password.')
			}
			currentPassword = ''
			newPassword = ''
			confirmPassword = ''
			message = payload.message ?? 'Password updated.'
			messageTone = 'info'
			if (!handle.props.hasUsablePassword) {
				handle.props.onPasswordSet()
			}
			queueSessionRefresh()
			toast.success('Password updated.')
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to update your password.'
			messageTone = 'error'
		} finally {
			status = 'idle'
			handle.update()
		}
	}

	return () => {
		const hasUsablePassword = handle.props.hasUsablePassword
		const isSaving = status === 'saving'
		const title = hasUsablePassword ? 'Change password' : 'Set a password'
		const canSubmit =
			newPassword.length > 0 &&
			confirmPassword.length > 0 &&
			(!hasUsablePassword || currentPassword.length > 0)

		return (
			<AccountManagementPanel
				title="Security"
				description="Change your password, add two-factor authentication, or sign in with passkeys."
			>
				<details mix={css(accountDisclosureCss)}>
					<summary>{title}</summary>
					<form
						data-testid="account-password-form"
						mix={[
							css({
								display: 'grid',
								gap: spacing.md,
								maxWidth: '26rem',
							}),
							on('submit', handleSubmit),
						]}
					>
						<p mix={css(accountFieldNoteCss)}>
							{hasUsablePassword
								? 'Other browser sessions and connected MCP hosts will need to sign in again.'
								: 'This account signs in with a connected provider or passkey. Setting a password lets you also sign in with email.'}
						</p>
						{hasUsablePassword ? (
							<label mix={css(accountFieldCss)}>
								<span mix={css(accountFieldLabelCss)}>Current password</span>
								<input
									type="password"
									name="currentPassword"
									data-field-ring
									required
									autoComplete="current-password"
									value={currentPassword}
									mix={[
										css(accountInputCss),
										on('input', updateCurrentPassword),
									]}
								/>
							</label>
						) : null}
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>New password</span>
							<input
								type="password"
								name="newPassword"
								data-field-ring
								required
								minLength={minPasswordLength}
								autoComplete="new-password"
								placeholder={`At least ${minPasswordLength} characters`}
								value={newPassword}
								mix={[css(accountInputCss), on('input', updateNewPassword)]}
							/>
						</label>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Confirm new password</span>
							<input
								type="password"
								name="confirmPassword"
								data-field-ring
								required
								minLength={minPasswordLength}
								autoComplete="new-password"
								value={confirmPassword}
								mix={[css(accountInputCss), on('input', updateConfirmPassword)]}
							/>
						</label>
						<div>
							<button
								type="submit"
								disabled={isSaving || !canSubmit}
								mix={css(compactPillButtonCss)}
							>
								{isSaving
									? 'Saving...'
									: hasUsablePassword
										? 'Update password'
										: 'Set password'}
							</button>
						</div>
						{message ? (
							<p
								role="status"
								mix={css({
									color: messageTone === 'error' ? colors.error : colors.text,
									margin: 0,
								})}
							>
								{message}
							</p>
						) : null}
					</form>
				</details>
				<div mix={css(accountActionsCss)}>
					<a href="/account/two-factor" mix={css(compactGhostButtonCss)}>
						Two-factor authentication
					</a>
					<a href="/account/passkeys" mix={css(compactGhostButtonCss)}>
						Passkeys
					</a>
				</div>
			</AccountManagementPanel>
		)
	}
}

const compactPillButtonCss = getPillButtonCss({ size: 'sm' })
const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
