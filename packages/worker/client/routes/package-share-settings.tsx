import { type RemixNode, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { type PackageShareGrantLoaderView } from '#universal/package-share.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

type PackageShareSettingsProps = {
	username: string
	kodyId: string
	grants: Array<PackageShareGrantLoaderView>
	inviteUsername: string
	inviteEmail: string
	busy: boolean
	message: string | null
	onInviteUsername: (value: string) => void
	onInviteEmail: (value: string) => void
	onInvite: () => void
	onRevoke: (grantId: string) => void
}

export function renderPackageShareSettings(
	props: PackageShareSettingsProps,
): RemixNode {
	const active = props.grants.filter(
		(grant) => grant.status === 'pending' || grant.status === 'accepted',
	)
	return (
		<section data-testid="package-share-settings" mix={css(sectionCss)}>
			<h2>Share</h2>
			<p>
				Invite another paid Kody account to use this package. Guests can read
				source and invoke. They cannot publish or write.
			</p>
			<form
				mix={[
					css(formCss),
					on('submit', (event) => {
						event.preventDefault()
						props.onInvite()
					}),
				]}
			>
				<label>
					Username
					<input
						type="text"
						name="username"
						autocomplete="username"
						value={props.inviteUsername}
						mix={on('input', (event) => {
							props.onInviteUsername(event.currentTarget.value)
						})}
					/>
				</label>
				<label>
					Email
					<input
						type="email"
						name="email"
						autocomplete="email"
						value={props.inviteEmail}
						mix={on('input', (event) => {
							props.onInviteEmail(event.currentTarget.value)
						})}
					/>
				</label>
				<button
					type="submit"
					disabled={props.busy}
					mix={css(getPillButtonCss({ size: 'sm' }))}
				>
					Send invite
				</button>
			</form>
			{props.message ? <p mix={css(messageCss)}>{props.message}</p> : null}
			{active.length === 0 ? (
				<p mix={css(emptyCss)}>Not shared with anyone yet.</p>
			) : (
				<ul mix={css(listCss)}>
					{active.map((grant) => (
						<li key={grant.id}>
							<div>
								<strong>
									{grant.granteeUsername
										? `@${grant.granteeUsername}`
										: grant.inviteeEmail}
								</strong>
								<span>
									{grant.status}
									{grant.trustLevel ? ` · ${grant.trustLevel}` : ''}
									{grant.pinAhead ? ' · pin ahead' : ''}
								</span>
							</div>
							<button
								type="button"
								disabled={props.busy}
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', () => props.onRevoke(grant.id)),
								]}
							>
								Revoke
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

export async function loadPackageShareGrants(input: {
	username: string
	kodyId: string
	signal?: AbortSignal
}) {
	const response = await fetch(
		`/profiles/${encodeURIComponent(input.username)}/packages/${encodeURIComponent(input.kodyId)}/share.json`,
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal: input.signal,
		},
	)
	if (!response.ok) {
		throw new Error('Unable to load share grants.')
	}
	const payload = (await response.json()) as {
		ok?: boolean
		grants?: Array<PackageShareGrantLoaderView>
	}
	if (!payload.ok) {
		throw new Error('Unable to load share grants.')
	}
	return payload.grants ?? []
}

const sectionCss = {
	marginTop: spacing['2xl'],
	display: 'grid',
	gap: spacing.md,
	'& h2': {
		margin: 0,
		fontSize: '1.1rem',
	},
	'& p': {
		margin: 0,
		color: colors.textMuted,
	},
}

const formCss = {
	display: 'grid',
	gap: spacing.sm,
	maxWidth: '24rem',
	'& label': {
		display: 'grid',
		gap: '0.25rem',
		fontSize: '0.88rem',
		color: colors.textMuted,
	},
	'& input': {
		padding: '0.45rem 0.6rem',
		border: `1px solid ${colors.border}`,
		borderRadius: '0.4rem',
		background: colors.surface,
		color: colors.text,
	},
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
	'& li': {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: spacing.md,
		padding: spacing.md,
		border: `1px solid ${colors.border}`,
		borderRadius: '0.5rem',
	},
	'& span': {
		display: 'block',
		color: colors.textMuted,
		fontSize: '0.88rem',
	},
}

const emptyCss = {
	color: colors.textMuted,
}

const messageCss = {
	color: colors.text,
}
