import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { mq, spacing } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'
import { postMarkEmailDestinationVerified } from './admin-users-destination-actions.ts'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })

/**
 * Admin unblock for destination verification: mark an address verified after
 * the person proves ownership out-of-band. Owns its draft + submit so the
 * parent admin-users route stays within the client-route line budget.
 */
export function AdminUserDestinationPanel(
	handle: Handle<{
		stableUserId: string
		onVerified?: () => void
	}>,
) {
	let destinationEmailDraft = ''
	let verifying = false
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	async function submitMarkDestinationVerified() {
		const destinationEmail = destinationEmailDraft.trim()
		if (verifying || destinationEmail === '') return
		verifying = true
		message = null
		handle.update()
		try {
			await postMarkEmailDestinationVerified({
				href: `${window.location.pathname}${window.location.search}`,
				stableUserId: handle.props.stableUserId,
				destinationEmail,
			})
			if (handle.signal.aborted) return
			destinationEmailDraft = ''
			message = `Marked ${destinationEmail} verified.`
			messageTone = 'info'
			handle.props.onVerified?.()
		} catch (error) {
			if (handle.signal.aborted) return
			if (error instanceof Error && error.message === 'Unauthorized.') return
			message =
				error instanceof Error
					? error.message
					: 'Unable to mark destination verified.'
			messageTone = 'error'
		}
		verifying = false
		handle.update()
	}

	return () => (
		<AccountManagementPanel
			title="Email destination"
			description="Mark an additional destination verified after the person proves they own it (for example they mailed their inbox from it). Use when destination verification mail never arrives."
		>
			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
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
						disabled={verifying}
						value={destinationEmailDraft}
						aria-label="Destination email"
						placeholder="extra@example.com"
						mix={[
							on('input', (event) => {
								destinationEmailDraft = event.currentTarget.value
								handle.update()
							}),
							css({ width: '100%' }),
						]}
					/>
				</label>
				<button
					type="button"
					disabled={verifying || destinationEmailDraft.trim() === ''}
					mix={[
						on('click', () => void submitMarkDestinationVerified()),
						css(primaryButtonCss),
					]}
				>
					{verifying ? 'Working…' : 'Mark destination verified'}
				</button>
			</div>
		</AccountManagementPanel>
	)
}
