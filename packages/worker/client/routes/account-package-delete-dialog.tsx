import { css, ref, type Handle } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate } from '#client/client-router.tsx'
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
} from './account-management-components.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

type DeleteStatus = 'idle' | 'deleting'

export function AccountPackageDeleteDialog(
	handle: Handle<{ packageDetail: AccountPackageDetail }>,
) {
	let dialogOpen = false
	let confirmation = ''
	let status: DeleteStatus = 'idle'
	let error: string | null = null
	let dialogNode: HTMLDialogElement | null = null

	function closeDialog() {
		dialogOpen = false
		confirmation = ''
		error = null
		status = 'idle'
		dialogNode?.close()
		handle.update()
	}

	function openDialog() {
		dialogOpen = true
		confirmation = ''
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

	async function handleDeleteSubmit(event: SubmitEvent) {
		event.preventDefault()
		const packageDetail = handle.props.packageDetail
		status = 'deleting'
		error = null
		handle.update()

		try {
			const response = await fetch('/account/packages.json', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'delete',
					packageId: packageDetail.id,
					confirmName: confirmation.trim(),
				}),
			})
			const payload = (await response.json().catch(() => null)) as {
				ok?: boolean
				deleted?: boolean
				error?: string
			} | null
			if (response.status === 401 && !payload?.error) {
				window.location.assign('/login')
				return
			}
			if (!response.ok || !payload?.ok || !payload.deleted) {
				throw new Error(payload?.error || 'Unable to delete this package.')
			}
			closeDialog()
			navigate(routes.accountPackages.href())
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to delete this package.'
			status = 'idle'
			handle.update()
		}
	}

	return () => {
		const packageName = handle.props.packageDetail.name
		const isDeleting = status === 'deleting'
		const canSubmit = confirmation.trim() === packageName && !isDeleting

		return (
			<>
				<div
					mix={css({ display: 'grid', gap: spacing.sm })}
					data-testid="package-delete-controls"
				>
					<p mix={css(accountFieldNoteCss)}>
						Permanently delete this package, its jobs, storage, secrets, tokens,
						and public listing if it has one. Existing forks keep their copies.
						This cannot be undone.
					</p>
					<div mix={css(accountActionsCss)}>
						<button
							type="button"
							data-testid="package-delete"
							mix={[
								css(getDangerPillCss({ size: 'sm' })),
								on('click', openDialog),
							]}
						>
							Delete package
						</button>
					</div>
				</div>
				<dialog
					aria-labelledby="delete-package-title"
					data-testid="package-delete-dialog"
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
						<h3 id="delete-package-title" mix={css(deleteDialogTitleCss)}>
							Delete {packageName}?
						</h3>
						<div
							mix={css(
								getAccentCalloutCss({
									accentColor: colors.error,
								}),
							)}
						>
							<p mix={css({ margin: 0 })}>
								This cannot be undone. Type <strong>{packageName}</strong> to
								confirm.
							</p>
						</div>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>
								Type the name of the package
							</span>
							<input
								type="text"
								name="confirmation"
								data-testid="package-delete-confirmation"
								data-field-ring
								autocomplete="off"
								spellcheck={false}
								required
								placeholder={packageName}
								value={confirmation}
								mix={[css(accountInputCss), on('input', updateConfirmation)]}
							/>
						</label>
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
								data-testid="package-delete-confirm"
								mix={css(getDangerPillCss({ size: 'sm' }))}
							>
								{isDeleting ? 'Deleting…' : 'Delete package'}
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
