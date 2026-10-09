import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { mq, spacing } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { AccountManagementPanel } from './account-management-components.tsx'
import { type AdminUsersActionState } from './admin-users-detail.tsx'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })

export function renderAdminUserDestinationPanel(input: {
	actionState: AdminUsersActionState
	isMutating: boolean
	destinationEmailDraft: string
	onDestinationEmailDraftChange: (email: string) => void
	onSubmitMarkDestinationVerified: () => void
}) {
	return (
		<AccountManagementPanel
			title="Email destination"
			description="Mark an additional destination verified after the person proves they own it (for example they mailed their inbox from it). Use when destination verification mail never arrives."
		>
			<div
				mix={css({
					display: 'grid',
					gap: spacing.md,
					gridTemplateColumns: 'minmax(0, 1fr) auto',
					alignItems: 'end',
					[mq.mobile]: { gridTemplateColumns: '1fr' },
				})}
			>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Destination email</span>
					<input
						data-field-ring
						type="email"
						disabled={input.isMutating}
						value={input.destinationEmailDraft}
						aria-label="Destination email"
						placeholder="extra@example.com"
						mix={[
							on('input', (event) => {
								input.onDestinationEmailDraftChange(event.currentTarget.value)
							}),
							css({ width: '100%' }),
						]}
					/>
				</label>
				<button
					type="button"
					disabled={
						input.isMutating || input.destinationEmailDraft.trim() === ''
					}
					mix={[
						on('click', () => input.onSubmitMarkDestinationVerified()),
						css(primaryButtonCss),
					]}
				>
					{input.isVerifying ? 'Working…' : 'Mark destination verified'}
				</button>
			</div>
		</AccountManagementPanel>
	)
}
