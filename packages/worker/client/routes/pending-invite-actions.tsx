import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { type AccountPendingInvite } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { spacing } from '#universal/styles/tokens.ts'

type PendingInviteRef = Pick<AccountPendingInvite, 'source' | 'id'>
type PendingInviteAction = 'accept' | 'decline'

function pendingInviteKey(invite: PendingInviteRef) {
	return `${invite.source}:${invite.id}`
}

function actionHref(invite: PendingInviteRef, action: PendingInviteAction) {
	const source = invite.source
	switch (source) {
		case 'link':
			return action === 'accept'
				? routes.accountInviteLinkAcceptPost.href({ linkId: invite.id })
				: routes.accountInviteLinkDeclinePost.href({ linkId: invite.id })
		case 'invite':
			return action === 'accept'
				? routes.accountInviteAcceptPost.href({ inviteId: invite.id })
				: routes.accountInviteDeclinePost.href({ inviteId: invite.id })
		default: {
			const exhaustive: never = source
			throw new Error(`Unknown invite source: ${String(exhaustive)}`)
		}
	}
}

async function postPendingInviteAction(
	invite: PendingInviteRef,
	action: PendingInviteAction,
) {
	const response = await fetch(actionHref(invite, action), {
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

export type PendingInviteActions = ReturnType<typeof createPendingInviteActions>

/**
 * Accept and Decline state for a list of pending invites. Accepting follows
 * the server's redirect to what was joined; anything else calls `reload` so
 * the list drops the row.
 */
export function createPendingInviteActions(
	handle: Handle,
	options: { reload: () => void },
) {
	let busyKey: string | null = null
	let message: string | null = null
	let tone: 'info' | 'error' = 'info'

	async function run(invite: PendingInviteRef, action: PendingInviteAction) {
		if (busyKey) return
		busyKey = pendingInviteKey(invite)
		message = null
		handle.update()
		try {
			const payload = await postPendingInviteAction(invite, action)
			if (action === 'accept' && payload.redirectTo) {
				window.location.assign(payload.redirectTo)
				return
			}
			message = action === 'accept' ? 'Invite accepted.' : 'Invite declined.'
			tone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to update that invite.'
			tone = 'error'
		}
		busyKey = null
		options.reload()
		handle.update()
	}

	return {
		get busyKey() {
			return busyKey
		},
		get message() {
			return message
		},
		get tone() {
			return tone
		},
		accept: (invite: PendingInviteRef) => void run(invite, 'accept'),
		decline: (invite: PendingInviteRef) => void run(invite, 'decline'),
	}
}

/** Accept and Decline for one pending invite row. */
export function renderPendingInviteActions(
	invite: PendingInviteRef,
	actions: PendingInviteActions,
) {
	const busy = actions.busyKey === pendingInviteKey(invite)
	return (
		<span mix={css(inviteActionsCss)}>
			<button
				type="button"
				disabled={actions.busyKey !== null}
				data-testid="pending-invite-accept"
				mix={[
					css(getPillButtonCss({ size: 'sm' })),
					on('click', () => actions.accept(invite)),
				]}
			>
				{busy ? 'Working…' : 'Accept'}
			</button>
			<button
				type="button"
				disabled={actions.busyKey !== null}
				data-testid="pending-invite-decline"
				mix={[
					css(getGhostButtonCss({ size: 'sm' })),
					on('click', () => actions.decline(invite)),
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
