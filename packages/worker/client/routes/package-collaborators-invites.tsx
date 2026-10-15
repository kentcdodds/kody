// remix-skill: personal-org invites on the package Collaborators tab.
import { type Handle, css } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { type createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountDisclosureCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import {
	type PackageCollaboratorInviteCreated,
	type PackageCollaboratorInviteView,
	type PackageCollaboratorPreset,
	type PackageCollaboratorsChange,
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
	packageCollaboratorInvitePresetExplanation,
	packageCollaboratorInviteeLabel,
	packageCollaboratorPresetLabel,
	packageCollaboratorPresets,
} from '#universal/package-collaborators.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	formCss,
	iconWellCss,
	listCss,
	mutedCopyCss,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
} from './package-collaborators-parts.tsx'

type PostChange = (
	key: string,
	change: PackageCollaboratorsChange,
	success: string,
) => Promise<PackageCollaboratorsWriteResult | null>

/**
 * A personal org has no members or teams, so its owner shares one package by
 * inviting someone: the invite form, the one-time handoff, pending invites,
 * and a pointer to team orgs for anything bigger.
 */
export function createPackageCollaboratorInvites(
	handle: Handle,
	input: {
		postChange: PostChange
		isBusy: () => boolean
		busyKey: () => string | null
		removeCheckFor: (key: string) => ReturnType<typeof createDoubleCheck>
	},
) {
	let invitee = ''
	let preset: PackageCollaboratorPreset = 'use'
	let created: PackageCollaboratorInviteCreated | null = null

	function reset() {
		invitee = ''
		preset = 'use'
		created = null
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault()
		created = null
		const result = await input.postChange(
			'invite',
			{ intent: 'invite', invitee: invitee.trim(), preset },
			'Invite created. Send it to them; it is shown only once.',
		)
		if (result?.invite) {
			invitee = ''
			preset = 'use'
			created = result.invite
			handle.update()
		}
	}

	function renderPresetChoice(option: PackageCollaboratorPreset) {
		const checked = option === preset
		return (
			<label
				key={option}
				mix={css(checked ? presetCardCheckedCss : presetCardCss)}
			>
				<input
					type="radio"
					name="package-invite-preset"
					value={option}
					checked={checked}
					mix={[
						css(presetRadioCss),
						on('change', () => {
							preset = option
							handle.update()
						}),
					]}
				/>
				<span mix={css({ display: 'grid', gap: '0.15rem' })}>
					<span mix={css({ fontWeight: 650 })}>
						{packageCollaboratorPresetLabel(option)}
					</span>
					<span mix={css(rowDetailCss)}>
						{packageCollaboratorInvitePresetExplanation(option)}
					</span>
				</span>
			</label>
		)
	}

	function renderCreated(invite: PackageCollaboratorInviteCreated) {
		return (
			<div
				data-testid="package-collaborators-invite-ready"
				mix={css(handoffCss)}
			>
				<p mix={css({ margin: 0, fontWeight: 650 })}>
					Invite ready for {invite.inviteeLabel}
				</p>
				<p mix={css(mutedCopyCss)}>
					Send this message to them. They paste it into their own agent
					connected to Kody to accept{' '}
					{packageCollaboratorPresetLabel(invite.preset).toLowerCase()} access.
					It is shown only once and expires{' '}
					{formatTimestampDate(invite.expiresAt)}.
				</p>
				<div mix={css(accountActionsCss)}>
					<CopyTextButton
						value={invite.prompt}
						idleLabel="Copy invite message"
						variant="pill"
						size="sm"
					/>
				</div>
				<details mix={css(accountDisclosureCss)}>
					<summary>Details</summary>
					<pre mix={css(promptCss)} data-testid="package-collaborators-prompt">
						{invite.prompt}
					</pre>
				</details>
			</div>
		)
	}

	function renderInviteForm() {
		const busy = input.isBusy()
		return (
			<AccountManagementPanel
				title="Invite a collaborator"
				description="Share this one package with someone outside your account. They get only this package, not your other packages or your credentials. Runs they start count toward your usage."
			>
				<form
					data-testid="package-collaborators-invite"
					mix={[css(formCss), on('submit', (event) => void submit(event))]}
				>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>Email or username</span>
						<input
							value={invitee}
							required
							data-field-ring
							autoComplete="off"
							placeholder="jesse@example.com or @jesse"
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									invitee = (event.currentTarget as HTMLInputElement).value
									handle.update()
								}),
							]}
						/>
						<p mix={css(accountFieldNoteCss)}>
							They need a Kody account with this email or username to accept.
						</p>
					</label>
					<fieldset mix={css(fieldsetCss)}>
						<legend mix={css(legendCss)}>What they can do</legend>
						{packageCollaboratorPresets.map(renderPresetChoice)}
					</fieldset>
					<div mix={css(accountActionsCss)}>
						<button
							type="submit"
							disabled={busy || invitee.trim().length === 0}
							mix={css(getPillButtonCss({ size: 'sm' }))}
						>
							{renderIcon('mail', { size: '1.05rem' })}
							{input.busyKey() === 'invite' ? 'Creating…' : 'Create invite'}
						</button>
					</div>
				</form>
				{created ? renderCreated(created) : null}
			</AccountManagementPanel>
		)
	}

	function renderPendingInvite(invite: PackageCollaboratorInviteView) {
		const check = input.removeCheckFor(`invite:${invite.id}`)
		const name = packageCollaboratorInviteeLabel(invite)
		return (
			<li
				key={invite.id}
				data-testid="package-collaborator-invite"
				mix={css(rowCss)}
			>
				<span aria-hidden="true" mix={css(iconWellCss)}>
					{renderIcon('mail', { size: '1.25rem' })}
				</span>
				<span mix={css(rowTextCss)}>
					<span mix={css(rowNameCss)}>{name}</span>
					<span mix={css(rowDetailCss)}>
						{[
							invite.preset
								? packageCollaboratorPresetLabel(invite.preset)
								: 'Custom access',
							`Expires ${formatTimestampDate(invite.expiresAt)}`,
						].join(' · ')}
					</span>
				</span>
				<span mix={css(rowActionsCss)}>
					<button
						type="button"
						disabled={input.isBusy()}
						mix={[
							css(getDangerPillCss({ size: 'sm' })),
							...check.getButtonMix({
								on: {
									click: () =>
										void input.postChange(
											`revoke-invite:${invite.id}`,
											{ intent: 'revoke-invite', inviteId: invite.id },
											`Revoked the invite for ${name}.`,
										),
								},
							}),
						]}
					>
						{renderIcon('close', { size: '1.05rem' })}
						{check.doubleCheck ? 'Confirm revoke' : 'Revoke'}
					</button>
				</span>
			</li>
		)
	}

	function renderPendingInvites(view: PackageCollaboratorsView) {
		if (view.invites.length === 0) return null
		return (
			<AccountManagementPanel
				title="Pending invites"
				description="Invites that have not been accepted yet. Revoke one to stop it from working."
			>
				<ul mix={css(listCss)} data-testid="package-collaborator-invites">
					{view.invites.map(renderPendingInvite)}
				</ul>
			</AccountManagementPanel>
		)
	}

	function renderTeamOrgCallout() {
		return (
			<aside
				data-testid="package-collaborators-team-callout"
				aria-label="Team organizations"
				mix={css(calloutCss)}
			>
				<span aria-hidden="true" mix={css(iconWellCss)}>
					{renderIcon('users', { size: '1.25rem' })}
				</span>
				<div mix={css({ display: 'grid', gap: spacing.sm, minWidth: 0 })}>
					<p mix={css({ margin: 0, fontWeight: 650 })}>Working with a group?</p>
					<p mix={css(mutedCopyCss)}>
						A team organization gives you members, teams, and seats, so you
						share packages with everyone at once instead of one invite at a
						time.
					</p>
					<div mix={css(accountActionsCss)}>
						<a
							href={routes.accountOrganizationsNew.href()}
							mix={css(getGhostButtonCss({ size: 'sm' }))}
						>
							{renderIcon('plus', { size: '1.05rem' })}
							Create a team organization
						</a>
						<a href={routes.docDetail.href({ slug: 'organizations' })}>
							Learn more
						</a>
					</div>
				</div>
			</aside>
		)
	}

	return {
		reset,
		render(view: PackageCollaboratorsView) {
			return (
				<>
					{renderInviteForm()}
					{renderPendingInvites(view)}
					{renderTeamOrgCallout()}
				</>
			)
		},
	}
}

const fieldsetCss = {
	margin: 0,
	padding: 0,
	border: 'none',
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}

const legendCss = {
	padding: 0,
	marginBottom: spacing.xs,
	fontWeight: 600,
}

const presetCardCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	padding: '0.75rem 0.9rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	cursor: 'pointer',
	minWidth: 0,
}

const presetCardCheckedCss = {
	...presetCardCss,
	borderColor: colors.primary,
}

const presetRadioCss = {
	marginTop: '0.25rem',
	flexShrink: 0,
	accentColor: colors.primary,
}

const handoffCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const promptCss = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.card,
	backgroundColor: colors.surface,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}

const calloutCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px dashed ${colors.border}`,
	minWidth: 0,
}
