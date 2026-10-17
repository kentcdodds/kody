import { css, type Handle } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { queueSessionRefresh } from '#client/session.ts'
import { toast } from '#client/toast.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'

type ConvertStatus = 'idle' | 'converting'

type ConvertResponse = {
	ok?: boolean
	error?: string
	code?: string
	convertedSlug?: string
	newUsername?: string
	redirectTo?: string
}

/**
 * One-time conversion: demote the signup org to a team org at `@current`,
 * mint `@new` as the personal account. Lives on Account settings only.
 */
export function AccountConvertPersonalOrgPanel(
	handle: Handle<{ username: string }>,
) {
	let confirmOpen = false
	let newHandle = ''
	let confirmText = ''
	let status: ConvertStatus = 'idle'
	let error: string | null = null

	function openConfirm() {
		confirmOpen = true
		confirmText = ''
		error = null
		handle.update()
	}

	function closeConfirm() {
		confirmOpen = false
		confirmText = ''
		error = null
		status = 'idle'
		handle.update()
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		status = 'converting'
		error = null
		handle.update()
		try {
			const response = await fetch(
				routes.accountConvertPersonalOrgPost.href(),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ newHandle }),
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<ConvertResponse>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error || 'Unable to convert your personal organization.',
				)
			}
			toast.success(
				`@${payload.convertedSlug} is now a team organization. Your personal account is @${payload.newUsername}.`,
			)
			queueSessionRefresh()
			window.location.assign(payload.redirectTo ?? routes.account.href())
		} catch (caught) {
			error =
				caught instanceof Error
					? caught.message
					: 'Unable to convert your personal organization.'
			status = 'idle'
			handle.update()
		}
	}

	return () => {
		const current = handle.props.username.trim()
		const expectedConfirm = current ? `convert @${current}` : ''
		const confirmReady =
			confirmOpen &&
			expectedConfirm.length > 0 &&
			confirmText.trim().toLowerCase() === expectedConfirm &&
			newHandle.trim().length > 0 &&
			status === 'idle'

		return (
			<AccountManagementPanel
				title="Convert personal organization"
				description="Turn your signup organization into a general-purpose team organization that keeps its handle, packages, and plan. You pick a new personal handle; memories, credentials, integrations, and MCP servers move with you."
			>
				{!confirmOpen ? (
					<div>
						<button
							type="button"
							data-testid="account-convert-personal-org-start"
							mix={[
								css(getGhostButtonCss({ size: 'sm' })),
								on('click', openConfirm),
							]}
						>
							Convert @{current || '…'}…
						</button>
					</div>
				) : (
					<form
						data-testid="account-convert-personal-org-form"
						mix={[
							css({ display: 'grid', gap: spacing.md }),
							on('submit', (event) => void handleSubmit(event)),
						]}
					>
						<p
							mix={css({
								margin: 0,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
								maxWidth: '60ch',
							})}
						>
							@{current} stays as a team organization you own. Packages,
							webhooks, email, and billing stay there. Your new personal
							organization starts from your current name and avatar.
						</p>
						<div mix={css(accountFieldCss)}>
							<label for="convert-new-handle" mix={css(accountFieldLabelCss)}>
								New personal handle
							</label>
							<input
								id="convert-new-handle"
								name="newHandle"
								data-testid="account-convert-personal-org-handle"
								data-field-ring
								autocomplete="off"
								spellcheck={false}
								value={newHandle}
								placeholder="new-handle"
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										newHandle = event.currentTarget.value
										handle.update()
									}),
								]}
							/>
							<p mix={css(accountFieldNoteCss)}>
								This becomes your username and the handle of your new personal
								organization. Choose carefully — handles stay put after this.
							</p>
						</div>
						<div mix={css(accountFieldCss)}>
							<label for="convert-confirm" mix={css(accountFieldLabelCss)}>
								Type {expectedConfirm} to confirm
							</label>
							<input
								id="convert-confirm"
								name="confirmation"
								data-testid="account-convert-personal-org-confirm"
								data-field-ring
								autocomplete="off"
								spellcheck={false}
								value={confirmText}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										confirmText = event.currentTarget.value
										handle.update()
									}),
								]}
							/>
						</div>
						{error ? (
							<p
								role="alert"
								data-testid="account-convert-personal-org-error"
								mix={css({
									margin: 0,
									color: colors.danger,
									fontSize: typography.fontSize.sm,
								})}
							>
								{error}
							</p>
						) : null}
						<div mix={css(accountActionsCss)}>
							<button
								type="button"
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', closeConfirm),
								]}
								disabled={status === 'converting'}
							>
								Cancel
							</button>
							<button
								type="submit"
								data-testid="account-convert-personal-org-submit"
								mix={css(
									confirmReady
										? getDangerPillCss({ size: 'sm' })
										: getPillButtonCss({ size: 'sm' }),
								)}
								disabled={!confirmReady}
							>
								{status === 'converting'
									? 'Converting…'
									: 'Convert organization'}
							</button>
						</div>
					</form>
				)}
			</AccountManagementPanel>
		)
	}
}
