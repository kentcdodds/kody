import { type Handle, type RemixNode, css } from 'remix/component'
import { Combobox, type ComboboxOption } from '#client/combobox.tsx'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { accountInputCss } from '#client/routes/account-management-components.tsx'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import { connectionProfileNameMaxLength } from '#universal/connection-profiles/names.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
	type AccountConnectionProfileView,
} from '#universal/loader-data.ts'
import {
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

type PackageOption = NonNullable<
	AccountConnectedAgentsLoaderData['connectionProfilePackageOptions']
>[number]

const grantActions = ['read', 'execute'] as const
type GrantAction = (typeof grantActions)[number]

type DraftGrant = {
	resourceId: string
	read: boolean
	execute: boolean
}

type EditDraft = {
	profileId: string
	grants: Array<DraftGrant>
}

/** Which form a mutation error belongs to: the create form or one profile. */
type MessageTarget = { kind: 'create' } | { kind: 'profile'; profileId: string }

/**
 * Named connection profiles on `/account/connections`. A profile lists only
 * the packages it grants, each with read/execute toggles, and adds more
 * through a package combobox — the same shape as a secret's allowed
 * packages — so an account with hundreds of packages does not render one
 * checkbox per package.
 */
export function createConnectionProfiles(
	handle: Handle,
	options: { onSaved: (payload: AccountConnectedAgentsLoaderData) => void },
) {
	let enabled = false
	let profiles: Array<AccountConnectionProfileView> = []
	let packageOptions: Array<PackageOption> = []
	let createName = ''
	let createGrants: Array<DraftGrant> = []
	let editDraft: EditDraft | null = null
	let busy = false
	let message: { target: MessageTarget; text: string } | null = null

	function applyPayload(payload: AccountConnectedAgentsLoaderData) {
		enabled = payload.connectionProfilesEnabled === true
		profiles = payload.connectionProfiles ?? []
		packageOptions = payload.connectionProfilePackageOptions ?? []
		if (
			editDraft &&
			!profiles.some((profile) => profile.id === editDraft?.profileId)
		) {
			editDraft = null
		}
	}

	async function postMutation(
		body: Record<string, unknown>,
		target: MessageTarget,
	) {
		if (busy) return false
		busy = true
		message = null
		handle.update()
		try {
			const response = await fetch(connectedAgentsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(body),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return false
			}
			const payload = await readJson<
				AccountConnectedAgentsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					(typeof payload?.error === 'string' ? payload.error : null) ??
						'Unable to update connection profile.',
				)
			}
			options.onSaved(payload)
			return true
		} catch (error) {
			message = {
				target,
				text:
					error instanceof Error ? error.message : 'Unable to update profile.',
			}
			return false
		} finally {
			busy = false
			handle.update()
		}
	}

	async function createProfile() {
		const saved = await postMutation(
			{
				intent: 'create',
				name: createName,
				grants: toGrantPayload(createGrants),
			},
			{ kind: 'create' },
		)
		if (saved) {
			createName = ''
			createGrants = []
			handle.update()
		}
	}

	async function saveEdit() {
		if (!editDraft) return
		const { profileId, grants } = editDraft
		const saved = await postMutation(
			{ intent: 'update', profileId, grants: toGrantPayload(grants) },
			{ kind: 'profile', profileId },
		)
		if (saved) {
			editDraft = null
			handle.update()
		}
	}

	function startEdit(profile: AccountConnectionProfileView) {
		editDraft = {
			profileId: profile.id,
			grants: profile.grants.map((grant) => ({
				resourceId: grant.resourceId,
				read: grant.actions.includes('read'),
				execute: grant.actions.includes('execute'),
			})),
		}
		message = null
		handle.update()
	}

	function cancelEdit() {
		editDraft = null
		message = null
		handle.update()
	}

	function grantsEditorHandlers(
		read: () => Array<DraftGrant>,
		write: (next: Array<DraftGrant>) => void,
	) {
		return {
			onAdd: (packageId: string) => {
				if (read().some((grant) => grant.resourceId === packageId)) return
				write([...read(), { resourceId: packageId, read: true, execute: true }])
				handle.update()
			},
			onRemove: (packageId: string) => {
				write(read().filter((grant) => grant.resourceId !== packageId))
				handle.update()
			},
			onToggleAction: (
				packageId: string,
				action: GrantAction,
				value: boolean,
			) => {
				write(
					read().map((grant) =>
						grant.resourceId === packageId
							? { ...grant, [action]: value }
							: grant,
					),
				)
				handle.update()
			},
		}
	}

	const createHandlers = grantsEditorHandlers(
		() => createGrants,
		(next) => {
			createGrants = next
		},
	)
	const editHandlers = grantsEditorHandlers(
		() => editDraft?.grants ?? [],
		(next) => {
			if (editDraft) editDraft = { ...editDraft, grants: next }
		},
	)

	function messageFor(target: MessageTarget) {
		if (!message) return null
		if (message.target.kind !== target.kind) return null
		if (
			message.target.kind === 'profile' &&
			target.kind === 'profile' &&
			message.target.profileId !== target.profileId
		) {
			return null
		}
		return <p mix={css(messageCss)}>{message.text}</p>
	}

	function render(input: {
		agents: Array<AccountConnectedAgentListItem>
	}): RemixNode {
		if (!enabled) return null
		const packagesById = new Map(packageOptions.map((pkg) => [pkg.id, pkg]))
		const comboboxOptions = toComboboxOptions(packageOptions)
		const unlimitedAgents = input.agents.filter(
			(agent) => !agent.connectionProfileName,
		)
		return (
			<section data-testid="connection-profiles" mix={css(sectionCss)}>
				<div mix={css(blockCss)}>
					<h2 mix={css(titleCss)}>Unlimited</h2>
					<p mix={css(copyCss)}>
						The default connection. No profile query param — the agent gets full
						access to this account (today’s behavior). Connections using
						Unlimited:
					</p>
					{renderAgentList(unlimitedAgents, 'No unlimited connections yet.')}
				</div>

				<div mix={css(blockCss)}>
					<h2 mix={css(titleCss)}>Profiles</h2>
					<p mix={css(copyCss)}>
						A named profile only grants the packages you add (read and/or
						execute). Paste the profile MCP URL into an agent; OAuth is
						unchanged. Profile names are at most{' '}
						{connectionProfileNameMaxLength} characters. “Unlimited” is
						reserved.
					</p>

					{profiles.length === 0 ? (
						<p mix={css(mutedCss)}>No profiles yet.</p>
					) : (
						<ul mix={css(profileListCss)}>
							{profiles.map((profile) => {
								const editing =
									editDraft?.profileId === profile.id ? editDraft : null
								return (
									<li
										key={profile.id}
										data-testid={`connection-profile-${profile.id}`}
										mix={css(cardCss)}
									>
										<div mix={css(profileHeaderCss)}>
											<strong>{profile.name}</strong>
											<div mix={css(buttonRowCss)}>
												{editing ? null : (
													<button
														type="button"
														disabled={busy || editDraft !== null}
														data-testid={`connection-profile-edit-${profile.id}`}
														aria-label={`Edit packages for ${profile.name}`}
														mix={[
															css(ghostButtonCss),
															on('click', () => startEdit(profile)),
														]}
													>
														Edit packages
													</button>
												)}
												<button
													type="button"
													disabled={busy}
													data-testid={`connection-profile-delete-${profile.id}`}
													aria-label={`Delete profile ${profile.name}`}
													mix={[
														css(ghostButtonCss),
														on('click', () => {
															void postMutation(
																{ intent: 'delete', profileId: profile.id },
																{ kind: 'profile', profileId: profile.id },
															)
														}),
													]}
												>
													Delete
												</button>
											</div>
										</div>
										{profile.mcpServerUrl ? (
											<CopyCard
												label="MCP URL"
												value={profile.mcpServerUrl}
												copyLabel="Copy MCP URL"
												variant="pill"
											/>
										) : null}
										{editing ? (
											<form
												data-testid={`connection-profile-edit-form-${profile.id}`}
												mix={[
													css(formCss),
													on('submit', (event) => {
														event.preventDefault()
														void saveEdit()
													}),
												]}
											>
												{renderGrantsEditor({
													idPrefix: `connection-profile-${profile.id}`,
													grants: editing.grants,
													packagesById,
													comboboxOptions,
													disabled: busy,
													...editHandlers,
												})}
												{messageFor({ kind: 'profile', profileId: profile.id })}
												<div mix={css(buttonRowCss)}>
													<button
														type="submit"
														disabled={busy}
														mix={css(pillButtonCss)}
													>
														Save packages
													</button>
													<button
														type="button"
														disabled={busy}
														mix={[css(ghostButtonCss), on('click', cancelEdit)]}
													>
														Cancel
													</button>
												</div>
											</form>
										) : (
											<>
												{renderGrantSummary(profile, packagesById)}
												{messageFor({ kind: 'profile', profileId: profile.id })}
											</>
										)}
										{renderAgentList(
											input.agents.filter(
												(agent) => agent.connectionProfileName === profile.name,
											),
											'No agents connected with this profile.',
										)}
									</li>
								)
							})}
						</ul>
					)}

					<form
						data-testid="connection-profile-create"
						mix={[
							css(cardCss),
							css(formCss),
							on('submit', (event) => {
								event.preventDefault()
								void createProfile()
							}),
						]}
					>
						<h3 mix={css(subtitleCss)}>Add profile</h3>
						<label mix={css(fieldCss)}>
							<span mix={css(fieldLabelCss)}>Name</span>
							<input
								data-field-ring
								type="text"
								name="name"
								maxLength={connectionProfileNameMaxLength}
								value={createName}
								disabled={busy}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										createName = event.currentTarget.value
										handle.update()
									}),
								]}
							/>
						</label>
						{renderGrantsEditor({
							idPrefix: 'connection-profile-create',
							grants: createGrants,
							packagesById,
							comboboxOptions,
							disabled: busy,
							...createHandlers,
						})}
						{messageFor({ kind: 'create' })}
						<div>
							<button type="submit" disabled={busy} mix={css(pillButtonCss)}>
								Create profile
							</button>
						</div>
					</form>
				</div>
			</section>
		)
	}

	return { applyPayload, render }
}

function toGrantPayload(grants: Array<DraftGrant>) {
	return grants
		.filter((grant) => grant.read || grant.execute)
		.map((grant) => ({
			resourceType: 'package',
			resourceId: grant.resourceId,
			actions: [
				...(grant.read ? (['read'] as const) : []),
				...(grant.execute ? (['execute'] as const) : []),
			],
		}))
}

function toComboboxOptions(
	packageOptions: Array<PackageOption>,
): Array<ComboboxOption> {
	return packageOptions
		.map((pkg) => ({
			id: pkg.id,
			label: pkg.kodyId,
			keywords: [pkg.name, pkg.id],
		}))
		.sort((left, right) => left.label.localeCompare(right.label))
}

function packageLabel(
	packageId: string,
	packagesById: ReadonlyMap<string, PackageOption>,
) {
	return packagesById.get(packageId)?.kodyId ?? 'Unknown package'
}

function sortByPackageLabel<T extends { resourceId: string }>(
	grants: ReadonlyArray<T>,
	packagesById: ReadonlyMap<string, PackageOption>,
) {
	return [...grants].sort((left, right) =>
		packageLabel(left.resourceId, packagesById).localeCompare(
			packageLabel(right.resourceId, packagesById),
		),
	)
}

function renderGrantSummary(
	profile: AccountConnectionProfileView,
	packagesById: ReadonlyMap<string, PackageOption>,
) {
	if (profile.grants.length === 0) {
		return (
			<p mix={css(mutedCss)}>
				No packages — this profile can see and run nothing.
			</p>
		)
	}
	return (
		<ul
			aria-label={`Packages granted to ${profile.name}`}
			mix={css(grantListCss)}
		>
			{sortByPackageLabel(profile.grants, packagesById).map((grant) => (
				<li key={grant.resourceId} mix={css(grantSummaryRowCss)}>
					<span mix={css(packageIdentityCss)}>
						{packageLabel(grant.resourceId, packagesById)}
					</span>
					<span mix={css(mutedCss)}>
						{grantActions
							.filter((action) => grant.actions.includes(action))
							.join(' · ')}
					</span>
				</li>
			))}
		</ul>
	)
}

function renderGrantsEditor(input: {
	idPrefix: string
	grants: Array<DraftGrant>
	packagesById: ReadonlyMap<string, PackageOption>
	comboboxOptions: Array<ComboboxOption>
	disabled: boolean
	onAdd: (packageId: string) => void
	onRemove: (packageId: string) => void
	onToggleAction: (
		packageId: string,
		action: GrantAction,
		value: boolean,
	) => void
}) {
	const grantedIds = new Set(input.grants.map((grant) => grant.resourceId))
	const available = input.comboboxOptions.filter(
		(option) => !grantedIds.has(option.id),
	)
	return (
		<div mix={css(editorCss)}>
			<span mix={css(fieldLabelCss)}>Packages</span>
			{input.grants.length === 0 ? (
				<p mix={css(mutedCss)}>
					No packages yet — this profile can see and run nothing.
				</p>
			) : (
				<ul mix={css(grantListCss)}>
					{sortByPackageLabel(input.grants, input.packagesById).map((grant) => {
						const label = packageLabel(grant.resourceId, input.packagesById)
						return (
							<li
								key={grant.resourceId}
								data-testid={`${input.idPrefix}-grant-${grant.resourceId}`}
								mix={css(grantEditRowCss)}
							>
								<span mix={css(packageIdentityCss)}>
									{label}
									{input.packagesById.has(grant.resourceId) ? null : (
										<code>{grant.resourceId}</code>
									)}
								</span>
								<div mix={css(actionsRowCss)}>
									{grantActions.map((action) => {
										const checked = grant[action]
										const otherChecked =
											action === 'read' ? grant.execute : grant.read
										return (
											<label key={action} mix={css(actionLabelCss)}>
												<input
													type="checkbox"
													checked={checked}
													// A granted package keeps at least one action;
													// Remove drops it entirely.
													disabled={
														input.disabled || (checked && !otherChecked)
													}
													aria-label={`${action} ${label}`}
													mix={on('change', (event) => {
														input.onToggleAction(
															grant.resourceId,
															action,
															event.currentTarget.checked,
														)
													})}
												/>
												{action}
											</label>
										)
									})}
									<button
										type="button"
										disabled={input.disabled}
										aria-label={`Remove package ${label}`}
										mix={[
											css(ghostButtonCss),
											on('click', () => input.onRemove(grant.resourceId)),
										]}
									>
										Remove
									</button>
								</div>
							</li>
						)
					})}
				</ul>
			)}
			{input.comboboxOptions.length === 0 ? (
				<p mix={css(mutedCss)}>Save a package first to grant it here.</p>
			) : available.length === 0 ? (
				<p mix={css(mutedCss)}>Every saved package is already added.</p>
			) : (
				<Combobox
					key={`${input.idPrefix}-add:${[...grantedIds].join(',')}`}
					id={`${input.idPrefix}-add-package`}
					label="Add package"
					placeholder="Search saved packages"
					value=""
					options={available}
					disabled={input.disabled}
					onChange={input.onAdd}
				/>
			)}
		</div>
	)
}

function renderAgentList(
	agents: Array<AccountConnectedAgentListItem>,
	emptyText: string,
) {
	if (agents.length === 0) return <p mix={css(mutedCss)}>{emptyText}</p>
	return (
		<ul mix={css(agentListCss)}>
			{agents.map((agent) => (
				<li key={agent.clientId}>{agent.label}</li>
			))}
		</ul>
	)
}

const pillButtonCss = getPillButtonCss({ size: 'sm' })
const ghostButtonCss = getGhostButtonCss({ size: 'sm' })

const sectionCss = {
	display: 'grid',
	gap: spacing.xl,
	marginBlockStart: spacing.xl,
}

const blockCss = {
	display: 'grid',
	gap: spacing.md,
}

const titleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
}

const subtitleCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
}

const copyCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '40rem',
}

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const agentListCss = {
	margin: 0,
	paddingInlineStart: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
}

const profileListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.lg,
}

const cardCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
}

const profileHeaderCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
}

const buttonRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}

const formCss = {
	display: 'grid',
	gap: spacing.md,
}

const editorCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}

const grantListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const grantSummaryRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: spacing.sm,
	fontSize: typography.fontSize.sm,
}

const grantEditRowCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'center',
	gap: spacing.sm,
	padding: spacing.sm,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
}

const packageIdentityCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	fontWeight: typography.fontWeight.medium,
	overflowWrap: 'anywhere' as const,
	'& code': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.normal,
	},
}

const actionsRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.md,
	fontSize: typography.fontSize.sm,
}

const actionLabelCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
}

const messageCss = {
	margin: 0,
	color: colors.danger,
	fontSize: typography.fontSize.sm,
}
