// remix-skill: package Collaborators tab (`/@user/name/collaborators`).
import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
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
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	type PackageCollaboratorPreset,
	type PackageCollaboratorsChange,
	type PackageCollaboratorsLoaderData,
	type PackageCollaboratorsView,
	type PackageCollaboratorView,
	packageCollaboratorPresetDescription,
	packageCollaboratorPresetLabel,
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
import { UserAvatar } from '#universal/user-avatar.tsx'
import {
	detailArticleCss,
	renderShellStatus,
} from './community-detail-sections.tsx'
import { loadPackageCollaboratorsPage } from './package-collaborators-data.ts'
import { PackageInviteLinksPanel } from './package-collaborators-invite-links.tsx'
import {
	collaboratorDetail,
	collaboratorName,
	formCss,
	iconWellCss,
	listCss,
	mutedCopyCss,
	readPreset,
	renderPresetOptions,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
	selectCss,
} from './package-collaborators-parts.tsx'

type ChangeKey = string

export function PackageCollaboratorsRoute(handle: Handle) {
	let writes = 0
	/** Writes that had landed when each view's GET started. */
	const fetchedAfterWrites = new WeakMap<PackageCollaboratorsView, number>()
	const pageData = createRouteData<
		'packageCollaborators',
		PackageCollaboratorsLoaderData
	>({
		key: 'packageCollaborators',
		fromLoaderData: (payload) => payload,
		async load(href, signal) {
			const writesAtStart = writes
			const result = await loadPackageCollaboratorsPage(href, signal)
			if (result.kind === 'redirect') return routeDataRedirect(result.to)
			if (result.data.ok)
				fetchedAfterWrites.set(result.data.view, writesAtStart)
			return result.data
		},
	})

	const removeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	/**
	 * The latest view a write returned, shown until a GET that started after
	 * that write lands; a GET already in flight may predate it.
	 */
	let written: {
		view: PackageCollaboratorsView
		writes: number
	} | null = null
	let reloadRequestedFor: PackageCollaboratorsView | null = null
	let statePathname: string | null = null
	let busy: ChangeKey | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let teamId = ''
	let teamPreset: PackageCollaboratorPreset = 'use'
	let memberId = ''
	let memberPreset: PackageCollaboratorPreset = 'use'
	let page = { username: '', kodyId: '' }

	function resetForPackage(pathname: string) {
		statePathname = pathname
		written = null
		message = null
		teamId = ''
		memberId = ''
		teamPreset = 'use'
		memberPreset = 'use'
		removeChecks.clear()
	}

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
		if (busy) return
		busy = key
		message = null
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
				| PackageCollaboratorsView
				| { ok: false; error?: string }
				| null
			if (response.status === 401) {
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(window.location.pathname)}`,
				)
				return
			}
			if (!response.ok || !payload?.ok) {
				throw new Error(
					(payload && !payload.ok ? payload.error : null) ||
						'Kody could not save that change.',
				)
			}
			writes += 1
			written = { view: payload, writes }
			message = success
			messageTone = 'info'
			pageData.reload(handle, readCurrentRouterHref(handle))
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Kody could not save that.'
			messageTone = 'error'
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

	function currentView(
		loaded: PackageCollaboratorsView | null,
		currentHref: string,
		pending: boolean,
	) {
		if (!written) return loaded
		if (!loaded) return written.view
		if (written.view.package.id !== loaded.package.id) return loaded
		if ((fetchedAfterWrites.get(loaded) ?? -1) >= written.writes) {
			written = null
			return loaded
		}
		if (!pending && reloadRequestedFor !== loaded) {
			reloadRequestedFor = loaded
			pageData.reload(handle, currentHref)
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
					{collaborator.kind === 'outside' ? (
						<span mix={css(rowDetailCss)}>
							{collaborator.preset
								? packageCollaboratorPresetLabel(collaborator.preset)
								: `Custom (${collaborator.permissions.length} permissions)`}
						</span>
					) : (
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
					)}
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
						No members left to add. Owners already have full access.
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
		if (pathname !== statePathname) resetForPackage(pathname)
		const pending = snapshot.kind === 'pending'
		const view = currentView(data?.view ?? null, currentHref, pending)
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
									? 'You always have full access to your own packages. People you invite show up here once they accept.'
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
						<PackageInviteLinksPanel
							username={username}
							kodyId={kodyId}
							orgSlug={view.org.slug}
							personal={view.org.personal}
						/>
					</>
				) : null}
			</article>
		)
	}
}
