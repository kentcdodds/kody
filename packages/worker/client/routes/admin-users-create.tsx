import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { css } from 'remix/ui'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { type AdminCreatedUserSetup } from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	accountInputCss,
	noticeCardCss,
} from './account-management-components.tsx'
import { type AdminUsersActionState } from './admin-users-detail.tsx'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })

export function renderAdminCreateUserPanel(input: {
	actionState: AdminUsersActionState
	createdUser: AdminCreatedUserSetup | null
	isMutating: boolean
	onSubmit: (event: SubmitEvent) => void
}) {
	return (
		<AccountManagementPanel
			title="Create user"
			description="Create a verified account with no usable password, then copy the setup link into a manual email."
			asForm
			onSubmit={input.onSubmit}
		>
			<div
				mix={css({
					display: 'grid',
					gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
					gap: spacing.md,
					alignItems: 'end',
					[mq.mobile]: {
						gridTemplateColumns: 'minmax(0, 1fr)',
						alignItems: 'stretch',
					},
				})}
			>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>User email</span>
					<input
						data-field-ring
						name="email"
						type="email"
						required
						placeholder="person@example.com"
						disabled={input.isMutating}
						mix={css(accountInputCss)}
					/>
				</label>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Username (optional)</span>
					<input
						data-field-ring
						name="username"
						type="text"
						placeholder="Auto-generated from email"
						disabled={input.isMutating}
						mix={css(accountInputCss)}
					/>
				</label>
				<button
					type="submit"
					disabled={input.isMutating}
					mix={css(primaryButtonCss)}
				>
					{input.actionState === 'creatingUser' ? 'Creating…' : 'Create user'}
				</button>
			</div>
			{input.createdUser ? (
				<div mix={css(noticeCardCss)}>
					<p mix={css({ margin: 0 })}>
						Setup link for <strong>{input.createdUser.email}</strong>:
					</p>
					<input
						data-field-ring
						readOnly
						aria-label="Password setup link"
						value={input.createdUser.setupLink}
						mix={css(accountInputCss)}
					/>
					<a
						href={input.createdUser.setupLink}
						mix={css({ color: colors.primary })}
					>
						Open setup link
					</a>
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						Expires{' '}
						{formatNullableTimestamp(
							new Date(input.createdUser.setupTokenExpiresAt).toISOString(),
						)}
						.
					</p>
				</div>
			) : null}
		</AccountManagementPanel>
	)
}
