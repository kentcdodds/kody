import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { spacing } from '#universal/styles/tokens.ts'

export type InviteLinkActions = {
	busyLinkId: string | null
	accept: (linkId: string) => void
	decline: (linkId: string) => void
}

export async function postInviteLinkAction(
	linkId: string,
	action: 'accept' | 'decline',
) {
	const href =
		action === 'accept'
			? routes.accountInviteLinkAcceptPost.href({ linkId })
			: routes.accountInviteLinkDeclinePost.href({ linkId })
	const response = await fetch(href, {
		method: 'POST',
		headers: { Accept: 'application/json' },
		credentials: 'include',
	})
	const payload = await readJson<{
		ok?: boolean
		error?: string
		redirectTo?: string
	}>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(
			payload?.error ||
				(action === 'accept'
					? 'Unable to accept this invite.'
					: 'Unable to decline this invite.'),
		)
	}
	return payload
}

/** Accept and Decline for one pending invite link row. */
export function renderInviteLinkActions(
	linkId: string,
	actions: InviteLinkActions,
) {
	const busy = actions.busyLinkId === linkId
	return (
		<span mix={css(inviteActionsCss)}>
			<button
				type="button"
				disabled={actions.busyLinkId !== null}
				data-testid="invite-link-accept"
				mix={[
					css(getPillButtonCss({ size: 'sm' })),
					on('click', () => actions.accept(linkId)),
				]}
			>
				{busy ? 'Working…' : 'Accept'}
			</button>
			<button
				type="button"
				disabled={actions.busyLinkId !== null}
				data-testid="invite-link-decline"
				mix={[
					css(getGhostButtonCss({ size: 'sm' })),
					on('click', () => actions.decline(linkId)),
				]}
			>
				Decline
			</button>
		</span>
	)
}

const inviteActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	flexShrink: 0,
}
