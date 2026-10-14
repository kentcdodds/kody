// remix-skill: package Collaborators tab (`/@user/name/collaborators`).
import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { NotFoundPage } from '#client/not-found-page.tsx'
import {
	createRouteData,
	renderRoutePendingStatus,
	routeDataRedirect,
} from '#client/route-data.tsx'
import { readRouterPathname } from '#client/router-location.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	isPackageCollaboratorPreset,
	type PackageCollaboratorInviteView,
	type PackageCollaboratorPreset,
	type PackageCollaboratorsChange,
	type PackageCollaboratorsLoaderData,
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
	type PackageCollaboratorView,
	packageCollaboratorKindLabel,
	packageCollaboratorPresetDescription,
	packageCollaboratorPresetLabel,
	packageCollaboratorPresets,
	readPackageCollaboratorsPath,
} from '#universal/package-collaborators.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from '#universal/package-repo-nav.tsx'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
import {
	detailArticleCss,
	renderShellStatus,
} from './community-detail-sections.tsx'
import { loadPackageCollaboratorsPage } from './package-collaborators-data.ts'

type ChangeKey = string

function collaboratorName(collaborator: PackageCollaboratorView) {
	if (collaborator.subjectType === 'team') return collaborator.label
	return collaborator.displayName?.trim() || collaborator.label
}

function collaboratorDetail(collaborator: PackageCollaboratorView) {
	const kind = packageCollaboratorKindLabel(collaborator.kind)
	if (collaborator.subjectType === 'team') {
		const count = collaborator.teamMemberCount
		return count === null
			? kind
			: `${kind} · ${count} ${count === 1 ? 'member' : 'members'}`
	}
	return collaborator.displayName?.trim()
		? `${collaborator.label} · ${kind}`
		: kind
}

function inviteeName(invite: PackageCollaboratorInviteView) {
	return (
		invite.inviteeEmail ??
		(invite.inviteeUsername ? `@${invite.inviteeUsername}` : 'Invite')
	)
}

function readPreset(event: Event): PackageCollaboratorPreset | null {
	const value = (event.currentTarget as HTMLSelectElement).value
	return isPackageCollaboratorPreset(value) ? value : null
}

function renderPresetOptions(selected: PackageCollaboratorPreset | null) {
	return packageCollaboratorPresets.map((preset) => (
		<option key={preset} value={preset} selected={preset === selected}>
			{packageCollaboratorPresetLabel(preset)}
		</option>
	))
}

export function PackageCollaboratorsRoute(handle: Handle) {
	const pageData = createRouteData<
		'packageCollaborators',
		PackageCollaboratorsLoaderData
	>({
		key: 'packageCollaborators',
		fromLoaderData: (payload) => payload,
		async load(href, signal) {
			const result = await loadPackageCollaboratorsPage(href, signal)
			if (result.kind === 'redirect') return routeDataRedirect(result.to)
			return result.data
		},
	})

	const removeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	/**
	 * The view a write returned, shown until a reload started after it lands
	 * (the loaded view it replaced is kept to tell the two apart).
	 */
	let written: {
		view: PackageCollaboratorsView
		replaced: PackageCollaboratorsView | null
	} | null = null
	let busy: ChangeKey | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let invitePrompt: string | null = null
	let teamId = ''
	let teamPreset: PackageCollaboratorPreset = 'use'
	let memberId = ''
	let memberPreset: PackageCollaboratorPreset = 'use'
	let invitee = ''
	let invitePreset: PackageCollaboratorPreset = 'use'
	let page = { username: '', kodyId: '' }
	let loadedView: PackageCollaboratorsView | null = null

	function removeCheckFor(key: string) {
		const existing = removeChecks.get(key)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		removeChecks.set(key, created)
		return created
	}

	async function postChange(
		key: ChangeKey,
		change: PackageCollaboratorsChange,
		success: string,
	) {
		if (busy) return null
		busy = key
		message = null
		invitePrompt = null
		handle.update()
		try {
			const response = await fetch(
				routes.communityPackageCollaboratorsApiPost.href(page),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify(change),
				},
			)
			const payload = (await response.json().catch(() => null)) as
				| PackageCollaboratorsWriteResult
				| { ok: false; error?: string }
				| null
			if (response.status === 401) {
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(window.location.pathname)}`,
				)
				return null
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(
					(payload && !payload.ok ? payload.error : null) ||
						'Kody could not save that change.',
				)
			}
			const { invite, ...view } = payload
			written = { view: { ...view, ok: true }, replaced: loadedView }
			message = success
			messageTone = 'info'
			pageData.reload(handle, readCurrentRouterHref(handle))
			return invite ?? null
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Kody could not save that.'
			messageTone = 'error'
			return null
		} finally {
			busy = null
			handle.update()
		}
	}

	async function changePreset(
		collaborator: PackageCollaboratorView,
		preset: PackageCollaboratorPreset,
		select: HTMLSelectElement,
	) {
		if (preset === collaborator.preset) return
		await postChange(
			`preset:${collaborator.grantId}`,
			{
				intent: 'grant',
				subjectType: collaborator.subjectType,
				subjectId: collaborator.subjectId,
				preset,
			},
			`${collaboratorName(collaborator)} can now ${packageCollaboratorPresetLabel(preset).toLowerCase()} this package.`,
		)
		if (messageTone === 'error') select.value = collaborator.preset ?? ''
	}

	async function addTeam(event: SubmitEvent, view: PackageCollaboratorsView) {
		event.preventDefault()
		const team = view.options.teams.find((option) => option.id === teamId)
		if (!team) return
		await postChange(
			'add-team',
			{
				intent: 'grant',
				subjectType: 'team',
				subjectId: team.id,
				preset: teamPreset,
			},
			`Added ${team.name}.`,
		)
		if (messageTone === 'info') teamId = ''
	}

	async function addMember(event: SubmitEvent, view: PackageCollaboratorsView) {
		event.preventDefault()
		const member = view.options.members.find(
			(option) => option.userId === memberId,
		)
		if (!member) return
		await postChange(
			'add-member',
			{
				intent: 'grant',
				subjectType: 'user',
				subjectId: member.userId,
				preset: memberPreset,
			},
			`Added ${member.username ? `@${member.username}` : 'that member'}.`,
		)
		if (messageTone === 'info') memberId = ''
	}

	async function invite(event: SubmitEvent) {
		event.preventDefault()
		const created = await postChange(
			'invite',
			{ intent: 'invite', invitee: invitee.trim(), preset: invitePreset },
			'Invite created. Send this prompt to them; it is shown only once.',
		)
		if (created) {
			invitee = ''
			invitePrompt = created.prompt
			handle.update()
		}
	}

	function currentView(
		loaded: PackageCollaboratorsView | null,
		pending: boolean,
	) {
		if (!written) return loaded
		if (!loaded || written.view.package.id !== loaded.package.id) {
			written = null
			return loaded
		}
		if (!pending && loaded !== written.replaced) {
			written = null
			return loaded
		}
		return written.view
	}

	function renderCollaborator(collaborator: PackageCollaboratorView) {
		const check = removeCheckFor(collaborator.grantId)
		const name = collaboratorName(collaborator)
		return (
			<li
				key={collaborator.grantId}
				data-testid="package-collaborator"
				data-subject={collaborator.subjectId}
				mix={css(rowCss)}
			>
				{collaborator.subjectType === 'team' ? (
					<span aria-hidden="true" mix={css(iconWellCss)}>
						{renderIcon('users', { size: '1.25rem' })}
					</span>
				) : (
					<UserAvatar
						displayName={name}
						avatarUrl={collaborator.avatarUrl}
						size={44}
						variant="well"
					/>
				)}
				<span mix={css(rowTextCss)}>
					<span mix={css(rowNameCss)}>{name}</span>
					<span mix={css(rowDetailCss)}>
						{collaboratorDetail(collaborator)}
					</span>
				</span>
				<span mix={css(rowActionsCss)}>
					<select
						aria-label={`Access for ${name}`}
						value={collaborator.preset ?? ''}
						disabled={busy !== null}
						mix={[
							css(selectCss),
							on('change', (event) => {
								const preset = readPreset(event)
								if (!preset) return
								void changePreset(
									collaborator,
									preset,
									event.currentTarget as HTMLSelectElement,
								)
							}),
						]}
					>
						{collaborator.preset === null ? (
							<option value="" disabled selected>
								Custom ({collaborator.permissions.length} permissions)
							</option>
						) : null}
						{renderPresetOptions(collaborator.preset)}
					</select>
					<button
						type="button"
						disabled={busy !== null}
						mix={[
							css(getDangerPillCss({ size: 'sm' })),
							...check.getButtonMix({
								on: {
									click: () =>
										void postChange(
											`revoke:${collaborator.grantId}`,
											{ intent: 'revoke', grantId: collaborator.grantId },
											`Removed ${name}.`,
										),
								},
							}),
						]}
					>
						{renderIcon('user-cross', { size: '1.05rem' })}
						{check.doubleCheck ? 'Confirm remove' : 'Remove'}
					</button>
				</span>
			</li>
		)
	}

	function renderPresetField(input: {
		label: string
		value: PackageCollaboratorPreset
		onChange: (preset: PackageCollaboratorPreset) => void
	}) {
		return (
			<label mix={css(accountFieldCss)}>
				<span mix={css(accountFieldLabelCss)}>Access</span>
				<select
					aria-label={input.label}
					value={input.value}
					mix={[
						css(selectCss),
						on('change', (event) => {
							const preset = readPreset(event)
							if (!preset) return
							input.onChange(preset)
							handle.update()
						}),
					]}
				>
					{renderPresetOptions(input.value)}
				</select>
				<p mix={css(accountFieldNoteCss)}>
					{packageCollaboratorPresetDescription(input.value)}.
				</p>
			</label>
		)
	}

	function renderAddTeam(view: PackageCollaboratorsView) {
		const teamsHref = routes.orgTeams.href({ orgSlug: view.org.slug })
		return (
			<AccountManagementPanel title="Add a team">
				{view.options.teams.length === 0 ? (
					<p mix={css(mutedCopyCss)}>
						Every team in this organization already has access, or there are no
						teams yet. <a href={teamsHref}>Manage teams</a>.
					</p>
				) : (
					<form
						data-testid="package-collaborators-add-team"
						mix={[
							css(formCss),
							on('submit', (event) => void addTeam(event, view)),
						]}
					>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Team</span>
							<select
								aria-label="Team"
								value={teamId}
								required
								mix={[
									css(selectCss),
									on('change', (event) => {
										teamId = (event.currentTarget as HTMLSelectElement).value
										handle.update()
									}),
								]}
							>
								<option value="" selected={teamId === ''}>
									Choose a team
								</option>
								{view.options.teams.map((team) => (
									<option
										key={team.id}
										value={team.id}
										selected={team.id === teamId}
									>
										{team.name} ({team.memberCount}{' '}
										{team.memberCount === 1 ? 'member' : 'members'})
									</option>
								))}
							</select>
						</label>
						{renderPresetField({
							label: 'Access for the team',
							value: teamPreset,
							onChange: (preset) => {
								teamPreset = preset
							},
						})}
						<div mix={css(accountActionsCss)}>
							<button
								type="submit"
								disabled={busy !== null || teamId === ''}
								mix={css(getPillButtonCss({ size: 'sm' }))}
							>
								{renderIcon('plus', { size: '1.05rem' })}
								{busy === 'add-team' ? 'Adding…' : 'Add team'}
							</button>
						</div>
					</form>
				)}
			</AccountManagementPanel>
		)
	}

	function renderAddMember(view: PackageCollaboratorsView) {
		return (
			<AccountManagementPanel title="Add an org member">
				{view.options.members.length === 0 ? (
					<p mix={css(mutedCopyCss)}>
						Every member of this organization already has access.
					</p>
				) : (
					<form
						data-testid="package-collaborators-add-member"
						mix={[
							css(formCss),
							on('submit', (event) => void addMember(event, view)),
						]}
					>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Member</span>
							<select
								aria-label="Member"
								value={memberId}
								required
								mix={[
									css(selectCss),
									on('change', (event) => {
										memberId = (event.currentTarget as HTMLSelectElement).value
										handle.update()
									}),
								]}
							>
								<option value="" selected={memberId === ''}>
									Choose a member
								</option>
								{view.options.members.map((member) => (
									<option
										key={member.userId}
										value={member.userId}
										selected={member.userId === memberId}
									>
										{member.username ? `@${member.username}` : member.userId}
										{member.displayName ? ` (${member.displayName})` : ''}
									</option>
								))}
							</select>
						</label>
						{renderPresetField({
							label: 'Access for the member',
							value: memberPreset,
							onChange: (preset) => {
								memberPreset = preset
							},
						})}
						<div mix={css(accountActionsCss)}>
							<button
								type="submit"
								disabled={busy !== null || memberId === ''}
								mix={css(getPillButtonCss({ size: 'sm' }))}
							>
								{renderIcon('plus', { size: '1.05rem' })}
								{busy === 'add-member' ? 'Adding…' : 'Add member'}
							</button>
						</div>
					</form>
				)}
			</AccountManagementPanel>
		)
	}

	function renderInvite(view: PackageCollaboratorsView) {
		return (
			<AccountManagementPanel
				title={
					view.org.personal
						? 'Invite a collaborator'
						: 'Invite someone outside the organization'
				}
				description="They get access to this package only, not to the rest of the organization or its credentials."
			>
				<form
					data-testid="package-collaborators-invite"
					mix={[css(formCss), on('submit', (event) => void invite(event))]}
				>
					<label mix={css(accountFieldCss)}>
						<span mix={css(accountFieldLabelCss)}>Email or username</span>
						<input
							value={invitee}
							required
							data-field-ring
							autoComplete="off"
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									invitee = (event.currentTarget as HTMLInputElement).value
									handle.update()
								}),
							]}
						/>
						<p mix={css(accountFieldNoteCss)}>
							They accept by pasting the invite prompt into their agent.
						</p>
					</label>
					{renderPresetField({
						label: 'Access for the invitee',
						value: invitePreset,
						onChange: (preset) => {
							invitePreset = preset
						},
					})}
					<div mix={css(accountActionsCss)}>
						<button
							type="submit"
							disabled={busy !== null || invitee.trim().length === 0}
							mix={css(getPillButtonCss({ size: 'sm' }))}
						>
							{renderIcon('mail', { size: '1.05rem' })}
							{busy === 'invite' ? 'Inviting…' : 'Create invite'}
						</button>
					</div>
				</form>
				{invitePrompt ? (
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						<pre
							mix={css(promptCss)}
							data-testid="package-collaborators-prompt"
						>
							{invitePrompt}
						</pre>
						<CopyTextButton
							value={invitePrompt}
							idleLabel="Copy invite prompt"
						/>
					</div>
				) : null}
			</AccountManagementPanel>
		)
	}

	function renderInvites(view: PackageCollaboratorsView) {
		if (view.invites.length === 0) return null
		return (
			<AccountManagementPanel title="Pending invites">
				<ul mix={css(listCss)} data-testid="package-collaborator-invites">
					{view.invites.map((pendingInvite) => {
						const check = removeCheckFor(`invite:${pendingInvite.id}`)
						const name = inviteeName(pendingInvite)
						return (
							<li
								key={pendingInvite.id}
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
											pendingInvite.preset
												? packageCollaboratorPresetLabel(pendingInvite.preset)
												: 'Custom access',
											`Expires ${formatTimestampDate(pendingInvite.expiresAt)}`,
										].join(' · ')}
									</span>
								</span>
								<span mix={css(rowActionsCss)}>
									<button
										type="button"
										disabled={busy !== null}
										mix={[
											css(getDangerPillCss({ size: 'sm' })),
											...check.getButtonMix({
												on: {
													click: () =>
														void postChange(
															`revoke-invite:${pendingInvite.id}`,
															{
																intent: 'revoke-invite',
																inviteId: pendingInvite.id,
															},
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
					})}
				</ul>
			</AccountManagementPanel>
		)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = readRouterPathname(handle)
		const path = readPackageCollaboratorsPath(pathname)
		if (!path) return <NotFoundPage />

		const snapshot = pageData.read(handle, currentHref)
		if (
			snapshot.kind === 'not-found' ||
			(snapshot.data?.ok === false && !snapshot.stale)
		) {
			return <NotFoundPage />
		}
		const data = snapshot.data?.ok ? snapshot.data : null
		const shell = data?.shell ?? null
		const username = shell?.username ?? path.username
		const kodyId = shell?.kodyId ?? path.kodyId
		page = { username, kodyId }
		const pending = snapshot.kind === 'pending'
		loadedView = data?.view ?? null
		const view = currentView(loadedView, pending)
		const statusMessage =
			snapshot.kind === 'error'
				? (snapshot.error?.message ?? 'Unable to load this package.')
				: data
					? ''
					: 'Loading collaborators…'

		return (
			<article
				mix={css(detailArticleCss)}
				data-testid="package-collaborators"
				aria-busy={pending && data ? 'true' : undefined}
			>
				{pending && data ? renderRoutePendingStatus() : null}
				{renderPackageRepoChrome({
					username,
					kodyId,
					isPrivate: shell?.isPrivate ?? false,
					isListed: shell?.isListed ?? false,
					viewerIsOwner: true,
					viewerCanManage: shell?.viewerCanManage ?? false,
					viewerCanManageAccess: true,
					active: 'collaborators',
					filesHref: getPackageTreeHref({
						username,
						kodyId,
						listingId: shell?.listingId ?? null,
						ref: shell?.defaultBranch || fallbackDefaultBranchName,
					}),
					description: shell?.description ?? '',
					ownerProfilePublic: shell?.ownerProfilePublic ?? true,
					iconUrl: resolvePackageListIconUrl({
						username,
						kodyId,
						listingId: shell?.listingId ?? null,
						listingIconCommit: null,
						publishedCommit: shell?.publishedCommit ?? null,
					}),
					iconName: kodyId,
				})}
				{renderShellStatus(statusMessage)}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{view ? (
					<>
						<AccountManagementPanel
							title="Who has access"
							description={
								view.org.personal
									? 'You always have full access to your own packages.'
									: 'Organization owners always have full access.'
							}
						>
							{view.collaborators.length === 0 ? (
								<p
									mix={css(mutedCopyCss)}
									data-testid="package-collaborators-empty"
								>
									Nobody else has been given access to this package yet.
								</p>
							) : (
								<ul mix={css(listCss)} data-testid="package-collaborators-list">
									{view.collaborators.map(renderCollaborator)}
								</ul>
							)}
						</AccountManagementPanel>
						{view.org.personal ? null : renderAddTeam(view)}
						{view.org.personal ? null : renderAddMember(view)}
						{renderInvite(view)}
						{renderInvites(view)}
					</>
				) : null}
			</article>
		)
	}
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	[mq.mobile]: {
		flexWrap: 'wrap',
		alignItems: 'flex-start',
	},
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
	[mq.mobile]: {
		flex: '1 1 0%',
		maxWidth: '100%',
	},
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[mq.mobile]: {
		whiteSpace: 'normal',
		overflowWrap: 'anywhere',
	},
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
	[mq.mobile]: {
		overflowWrap: 'anywhere',
	},
}

const rowActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	flexShrink: 0,
	[mq.mobile]: {
		flex: '1 0 100%',
		maxWidth: '100%',
		minWidth: 0,
	},
}

const selectCss = {
	...accountInputCss,
	width: 'auto',
	minWidth: '8rem',
	padding: '0.45rem 0.7rem',
	[mq.mobile]: {
		minWidth: 'min(100%, 8rem)',
		maxWidth: '100%',
	},
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

const iconWellCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	flexShrink: 0,
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
}

const promptCss = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.card,
	backgroundColor: colors.background,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}
