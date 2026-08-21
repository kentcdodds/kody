import { css, ref, type Handle } from 'remix/ui'
import { accountDeletionConfirmationPhrase } from '#universal/account-deletion-confirmation.ts'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'

type DeleteStatus = 'idle' | 'deleting'

export function AccountDeletePanel(
	handle: Handle<{ hasUsablePassword: boolean }>,
) {
	let dialogOpen = false
	let confirmation = ''
	let password = ''
	let status: DeleteStatus = 'idle'
	let error: string | null = null
	let dialogNode: HTMLDialogElement | null = null

	function closeDialog() {
		dialogOpen = false
		confirmation = ''
		password = ''
		error = null
		status = 'idle'
		dialogNode?.close()
		handle.update()
	}

	function openDialog() {
		dialogOpen = true
		confirmation = ''
		password = ''
		error = null
		status = 'idle'
		handle.update()
		dialogNode?.showModal()
	}

	function updateConfirmation(event: Event) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		confirmation = event.currentTarget.value
		handle.update()
	}

	function updatePassword(event: Event) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		password = event.currentTarget.value
		handle.update()
	}

	async function handleDeleteSubmit(event: SubmitEvent) {
		event.preventDefault()
		status = 'deleting'
		error = null
		handle.update()

		try {
			const response = await fetch(routes.accountDelete.href(), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					confirmation,
					...(handle.props.hasUsablePassword ? { password } : {}),
				}),
			})
			const payload = (await response.json().catch(() => null)) as {
				error?: string
				ok?: boolean
			} | null
			if (response.status === 401 && !payload?.error) {
				window.location.assign('/login')
				return
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to delete your account.')
			}
			window.location.assign('/')
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to delete your account.'
			status = 'idle'
			handle.update()
		}
	}

	return () => {
		const isDeleting = status === 'deleting'
		const confirmationMatches =
			confirmation.trim() === accountDeletionConfirmationPhrase
		const canSubmit =
			confirmationMatches &&
			(!handle.props.hasUsablePassword || password.length > 0) &&
			!isDeleting

		return (
			<>
				<div mix={css({ display: 'grid', gap: spacing.md, maxWidth: '36rem' })}>
					<p mix={css(accountFieldNoteCss)}>
						This permanently deletes your account, packages, jobs, email,
						secrets, and stored data. Download an export first if you want a
						copy.
					</p>
					<div mix={css(accountActionsCss)}>
						<button
							type="button"
							data-testid="delete-account"
							mix={[
								css(getDangerPillCss({ size: 'sm' })),
								on('click', openDialog),
							]}
						>
							Delete account
						</button>
					</div>
				</div>
				<dialog
					aria-labelledby="delete-account-title"
					data-testid="delete-account-dialog"
					mix={[
						css(deleteDialogCss),
						ref((node, signal) => {
							if (!(node instanceof HTMLDialogElement)) return
							dialogNode = node
							if (dialogOpen && !node.open) node.showModal()
							signal.addEventListener('abort', () => {
								dialogNode = null
							})
						}),
						on('cancel', (event) => {
							event.preventDefault()
							closeDialog()
						}),
						on('click', (event) => {
							if (event.target === event.currentTarget) closeDialog()
						}),
					]}
				>
					<form
						method="dialog"
						mix={[css(deleteDialogFormCss), on('submit', handleDeleteSubmit)]}
					>
						<h3 id="delete-account-title" mix={css(deleteDialogTitleCss)}>
							Delete your Kody account?
						</h3>
						<div
							mix={css(
								getAccentCalloutCss({
									accentColor: colors.error,
								}),
							)}
						>
							<p mix={css({ margin: 0 })}>
								This cannot be undone. Type{' '}
								<strong>{accountDeletionConfirmationPhrase}</strong> to confirm.
							</p>
						</div>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>
								Type {accountDeletionConfirmationPhrase}
							</span>
							<input
								type="text"
								name="confirmation"
								data-testid="delete-account-confirmation"
								data-field-ring
								autocomplete="off"
								spellcheck={false}
								required
								value={confirmation}
								mix={[css(accountInputCss), on('input', updateConfirmation)]}
							/>
						</label>
						{handle.props.hasUsablePassword ? (
							<label mix={css(accountFieldCss)}>
								<span mix={css(accountFieldLabelCss)}>Current password</span>
								<input
									type="password"
									name="password"
									data-testid="delete-account-password"
									data-field-ring
									required
									{...passwordManagerIgnoreProps}
									value={password}
									mix={[css(accountInputCss), on('input', updatePassword)]}
								/>
							</label>
						) : null}
						{error ? (
							<p
								role="alert"
								mix={css({
									margin: 0,
									color: colors.error,
									fontSize: typography.fontSize.sm,
								})}
							>
								{error}
							</p>
						) : null}
						<div mix={css(accountActionsCss)}>
							<button
								type="button"
								disabled={isDeleting}
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', closeDialog),
								]}
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={!canSubmit}
								data-testid="delete-account-confirm"
								mix={css(getDangerPillCss({ size: 'sm' }))}
							>
								{isDeleting ? 'Deleting…' : 'Delete account'}
							</button>
						</div>
					</form>
				</dialog>
			</>
		)
	}
}

const deleteDialogCss = {
	width: 'min(32rem, calc(100vw - 2rem))',
	maxWidth: '32rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.45)',
	},
}

const deleteDialogFormCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
}

const deleteDialogTitleCss = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}
