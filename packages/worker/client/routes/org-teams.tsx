import { css, type Handle } from 'remix/component'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderIcon } from '#universal/icon.tsx'
import {
	type OrgTeamView,
	type OrgTeamsLoaderData,
} from '#universal/loader-data.ts'
import { orgIdentity } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

type TeamsPayload = OrgTeamsLoaderData & { error?: string }

async function fetchTeams(
	slug: string,
	signal: AbortSignal,
): Promise<TeamsPayload | 'unauthorized' | 'not-found'> {
	const response = await fetch(routes.orgTeamsApi.href({ orgSlug: slug }), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized'
	if (response.status === 404) return 'not-found'
	const payload = (await response
		.json()
		.catch(() => null)) as TeamsPayload | null
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to load teams.')
	}
	return payload
}

function slugFromHref(href: string) {
	const match = /^\/@([^/]+)\/-\/teams/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ?? ''
}

function memberLabel(member: {
	username: string | null
	displayName: string | null
	userId: string
}) {
	return (
		member.displayName?.trim() ||
		(member.username ? `@${member.username}` : member.userId)
	)
}

export async function orgTeamsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchTeams(slugFromHref(url.pathname), signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	if (payload === 'not-found') {
		return routeLoaderRedirect(routes.notFoundPage.href())
	}
	return { orgTeams: payload }
}

export function OrgTeamsRoute(handle: Handle) {
	const teamsData = createRouteData({
		key: 'orgTeams',
		async load(href, signal) {
			const payload = await fetchTeams(slugFromHref(href), signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			if (payload === 'not-found') throw new Error('Organization unavailable.')
			return payload
		},
	})

	const removeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	let createSlug = ''
	let createName = ''
	let createDescription = ''
	let creating = false
	let addByTeam = new Map<string, string>()
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	function removeCheckFor(key: string) {
		const existing = removeChecks.get(key)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		removeChecks.set(key, created)
		return created
	}

	async function postTeams(
		path: 'create' | 'member-add' | 'member-remove',
		body: Record<string, unknown>,
	) {
		const snapshot = teamsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok) return
		const href =
			path === 'create'
				? routes.orgTeamsCreatePost.href({ orgSlug: data.org.slug })
				: path === 'member-add'
					? routes.orgTeamsMemberAddPost.href({ orgSlug: data.org.slug })
					: routes.orgTeamsMemberRemovePost.href({ orgSlug: data.org.slug })
		const response = await fetch(href, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify(body),
		})
		const payload = (await response
			.json()
			.catch(() => null)) as TeamsPayload | null
		if (response.status === 401) {
			window.location.assign('/login')
			// Throw so callers do not clear the form or show a success banner
			// while the redirect is pending.
			throw new Error('Sign in again to continue.')
		}
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error || 'Unable to update teams.')
		}
		teamsData.reload(handle, readCurrentRouterHref(handle))
		return payload
	}

	async function createTeam(event: SubmitEvent) {
		event.preventDefault()
		creating = true
		message = null
		handle.update()
		try {
			await postTeams('create', {
				slug: createSlug,
				name: createName,
				description: createDescription,
			})
			createSlug = ''
			createName = ''
			createDescription = ''
			message = 'Team created.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Unable to create that team.'
			messageTone = 'error'
		} finally {
			creating = false
			handle.update()
		}
	}

	async function addMember(teamId: string) {
		const userId = addByTeam.get(teamId)?.trim() ?? ''
		if (!userId) return
		message = null
		handle.update()
		try {
			await postTeams('member-add', { teamId, userId })
			addByTeam.set(teamId, '')
			message = 'Member added to the team.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to add that person to the team.'
			messageTone = 'error'
		}
		handle.update()
	}

	async function removeMember(teamId: string, userId: string) {
		message = null
		handle.update()
		try {
			await postTeams('member-remove', { teamId, userId })
			message = 'Member removed from the team.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to remove that person from the team.'
			messageTone = 'error'
		}
		handle.update()
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		tryConsumeRouteLoaderData(handle, 'orgTeams', href)
		const snapshot = teamsData.read(handle, href)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Teams"
					description="Groups inside this organization for package grants and shared work."
					currentHref={href}
				/>
				{snapshot.kind === 'error' ? (
					<AccountManagementMessage tone="error">
						{snapshot.error?.message ?? 'Unable to load teams.'}
					</AccountManagementMessage>
				) : null}
				{!data && snapshot.kind === 'pending' ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading teams…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{data?.ok ? (
					<>
						<AccountManagementPanel
							title="Teams"
							ariaLabel="Organization teams"
						>
							{data.teams.length === 0 ? (
								<p mix={css(mutedCopyCss)} data-testid="org-teams-empty">
									No teams yet.
								</p>
							) : (
								<ul mix={css(listCss)} data-testid="org-teams">
									{data.teams.map((team) => (
										<li
											key={team.id}
											data-testid="org-team"
											mix={css(teamCardCss)}
										>
											<div mix={css(teamHeaderCss)}>
												<span mix={css(rowTextCss)}>
													<span mix={css(rowNameCss)}>{team.name}</span>
													<span mix={css(rowDetailCss)}>
														@{team.slug}
														{team.description?.trim()
															? ` · ${team.description.trim()}`
															: ''}
														{` · ${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`}
													</span>
												</span>
											</div>
											{team.members.length > 0 ? (
												<ul mix={css(memberListCss)}>
													{team.members.map((member) => {
														const checkKey = `${team.id}:${member.userId}`
														const check = removeCheckFor(checkKey)
														const identity = orgIdentity(
															{
																slug: member.username ?? member.userId,
																displayName: member.displayName,
																personal: false,
																avatarUrl: member.avatarUrl,
															},
															{ displayName: '', avatarUrl: null },
														)
														return (
															<li key={member.userId} mix={css(rowItemCss)}>
																<div mix={css(rowCss)}>
																	<UserAvatar
																		displayName={identity.avatarName}
																		avatarUrl={member.avatarUrl}
																		size={36}
																		variant="well"
																	/>
																	<span mix={css(rowTextCss)}>
																		<span mix={css(rowNameCss)}>
																			{memberLabel(member)}
																		</span>
																		{member.username ? (
																			<span mix={css(rowDetailCss)}>
																				@{member.username}
																			</span>
																		) : null}
																	</span>
																	{data.canRemoveMembers ? (
																		<button
																			type="button"
																			mix={[
																				css(getDangerPillCss({ size: 'sm' })),
																				...check.getButtonMix({
																					on: {
																						click: () =>
																							void removeMember(
																								team.id,
																								member.userId,
																							),
																					},
																				}),
																			]}
																		>
																			{renderIcon('user-cross', {
																				size: '1.05rem',
																			})}
																			{check.doubleCheck
																				? 'Confirm remove'
																				: 'Remove'}
																		</button>
																	) : null}
																</div>
															</li>
														)
													})}
												</ul>
											) : (
												<p mix={css(mutedCopyCss)}>No members on this team.</p>
											)}
											{data.canManage ? (
												<div mix={css(addRowCss)}>
													<select
														aria-label={`Add member to ${team.name}`}
														value={addByTeam.get(team.id) ?? ''}
														mix={[
															css(selectCss),
															on('change', (event) => {
																addByTeam.set(
																	team.id,
																	(event.currentTarget as HTMLSelectElement)
																		.value,
																)
																handle.update()
															}),
														]}
													>
														<option value="">Add a member…</option>
														{eligibleMembers(data, team).map((member) => (
															<option key={member.userId} value={member.userId}>
																{memberLabel(member)}
															</option>
														))}
													</select>
													<button
														type="button"
														disabled={!addByTeam.get(team.id)}
														mix={[
															css(getPillButtonCss({ size: 'sm' })),
															on('click', () => void addMember(team.id)),
														]}
													>
														{renderIcon('plus', { size: '1.05rem' })}
														Add
													</button>
												</div>
											) : null}
										</li>
									))}
								</ul>
							)}
						</AccountManagementPanel>
						{data.canManage ? (
							<AccountManagementPanel title="Create team">
								<form
									data-testid="org-team-create-form"
									mix={[
										css(formCss),
										on('submit', (event) => void createTeam(event)),
									]}
								>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>Handle</span>
										<input
											value={createSlug}
											required
											data-field-ring
											autoComplete="off"
											mix={[
												css(accountInputCss),
												on('input', (event) => {
													createSlug = (event.currentTarget as HTMLInputElement)
														.value
													handle.update()
												}),
											]}
										/>
										<p mix={css(accountFieldNoteCss)}>
											Unique inside this organization. Lowercase letters,
											numbers, and hyphens.
										</p>
									</label>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>Name</span>
										<input
											value={createName}
											data-field-ring
											autoComplete="off"
											mix={[
												css(accountInputCss),
												on('input', (event) => {
													createName = (event.currentTarget as HTMLInputElement)
														.value
													handle.update()
												}),
											]}
										/>
									</label>
									<label mix={css(accountFieldCss)}>
										<span mix={css(accountFieldLabelCss)}>Description</span>
										<input
											value={createDescription}
											data-field-ring
											autoComplete="off"
											mix={[
												css(accountInputCss),
												on('input', (event) => {
													createDescription = (
														event.currentTarget as HTMLInputElement
													).value
													handle.update()
												}),
											]}
										/>
									</label>
									<div mix={css(accountActionsCss)}>
										<button
											type="submit"
											disabled={creating || createSlug.trim().length === 0}
											mix={css(getPillButtonCss({ size: 'sm' }))}
										>
											{renderIcon('plus', { size: '1.05rem' })}
											{creating ? 'Creating…' : 'Create team'}
										</button>
									</div>
								</form>
							</AccountManagementPanel>
						) : null}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

function eligibleMembers(data: OrgTeamsLoaderData, team: OrgTeamView) {
	const onTeam = new Set(team.members.map((member) => member.userId))
	return data.orgMembers.filter((member) => !onTeam.has(member.userId))
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
	gap: spacing.md,
}

const memberListCss = {
	listStyle: 'none',
	margin: `${spacing.sm} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const teamCardCss = {
	minWidth: 0,
	padding: '1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	display: 'grid',
	gap: spacing.sm,
}

const teamHeaderCss = {
	display: 'flex',
	alignItems: 'flex-start',
	justifyContent: 'space-between',
	gap: spacing.md,
}

const rowItemCss = {
	minWidth: 0,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const addRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	marginTop: spacing.sm,
}

const selectCss = {
	...accountInputCss,
	width: 'auto',
	minWidth: '12rem',
	flex: '1 1 auto',
	padding: '0.45rem 0.7rem',
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
}
