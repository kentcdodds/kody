import { css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { type AccountFormerEmail } from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'

export type AccountFormerEmailsPanelProps = {
	formerEmails: Array<AccountFormerEmail>
	releaseEmail: string
	releasePassword: string
	releaseStatus: 'idle' | 'sending'
	releaseMessage: string | null
	releaseTone: 'error' | 'info'
	onReleaseEmailInput: (event: InputEvent) => void
	onReleasePasswordInput: (event: InputEvent) => void
	onReleaseSubmit: (event: SubmitEvent) => void
	onUseAgainAsLogin: (email: string) => void
	onReleaseListed: (email: string) => void
}

export function renderAccountFormerEmailsPanel(
	props: AccountFormerEmailsPanelProps,
) {
	const {
		formerEmails,
		releaseEmail,
		releasePassword,
		releaseStatus,
		releaseMessage,
		releaseTone,
		onReleaseEmailInput,
		onReleasePasswordInput,
		onReleaseSubmit,
		onUseAgainAsLogin,
		onReleaseListed,
	} = props
	const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
	const compactPillButtonCss = getPillButtonCss({ size: 'sm' })
	const isSending = releaseStatus === 'sending'

	return (
		<AccountManagementPanel
			title="Former addresses"
			description="Verified emails that still belong to this account. Release one after you confirm you still own it if you want that address to open a new Kody account."
		>
			{formerEmails.length > 0 ? (
				<ul
					mix={css({
						listStyle: 'none',
						margin: 0,
						padding: 0,
						display: 'grid',
						gap: spacing.md,
					})}
				>
					{formerEmails.map((claim) => (
						<li
							key={claim.email}
							mix={css({
								display: 'grid',
								gap: spacing.sm,
							})}
						>
							<p mix={css({ margin: 0 })}>{claim.email}</p>
							<div
								mix={css({
									display: 'flex',
									flexWrap: 'wrap',
									gap: spacing.sm,
								})}
							>
								<button
									type="button"
									disabled={isSending}
									mix={[
										css(compactPillButtonCss),
										on('click', () => {
											onReleaseListed(claim.email)
										}),
									]}
								>
									Release
								</button>
								<button
									type="button"
									disabled={isSending}
									mix={[
										css(compactGhostButtonCss),
										on('click', () => {
											onUseAgainAsLogin(claim.email)
										}),
									]}
								>
									Use again as login
								</button>
							</div>
						</li>
					))}
				</ul>
			) : (
				<p mix={css(accountFieldNoteCss)}>
					No former addresses are listed yet. If you changed email before this
					list existed, enter that old verified address below to release it.
				</p>
			)}
			<form
				{...passwordManagerIgnoreProps}
				mix={[
					css({
						display: 'grid',
						gap: spacing.md,
						maxWidth: '26rem',
						marginTop: spacing.sm,
					}),
					on('submit', onReleaseSubmit),
				]}
			>
				<p mix={css(accountFieldNoteCss)}>
					We send a confirmation link to the former address. Releasing it does
					not change this account&apos;s identity.
				</p>
				<label mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Former email</span>
					<input
						type="email"
						name="former_email"
						data-field-ring
						required
						autoComplete="off"
						value={releaseEmail}
						mix={[css(accountInputCss), on('input', onReleaseEmailInput)]}
					/>
				</label>
				<label mix={css(accountFieldCss)}>
					<span mix={css(accountFieldLabelCss)}>Current password</span>
					<input
						type="password"
						name="password"
						data-field-ring
						required
						{...passwordManagerIgnoreProps}
						value={releasePassword}
						mix={[css(accountInputCss), on('input', onReleasePasswordInput)]}
					/>
				</label>
				<div>
					<button
						type="submit"
						disabled={isSending || !releaseEmail.trim() || !releasePassword}
						mix={css(compactGhostButtonCss)}
					>
						{isSending ? 'Sending...' : 'Send release link'}
					</button>
				</div>
				{releaseMessage ? (
					<p
						role="status"
						mix={css({
							color: releaseTone === 'error' ? colors.error : colors.text,
							margin: 0,
						})}
					>
						{releaseMessage}
					</p>
				) : null}
			</form>
		</AccountManagementPanel>
	)
}
