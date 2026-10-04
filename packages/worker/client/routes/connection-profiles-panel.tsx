import { type RemixNode, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import {
	type AccountConnectionProfileView,
	type AccountConnectedAgentListItem,
} from '#universal/loader-data.ts'
import { connectionProfileNameMaxLength } from '#universal/connection-profiles/names.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export type ConnectionProfilesPanelState = {
	profiles: Array<AccountConnectionProfileView>
	packageOptions: Array<{ id: string; name: string; kodyId: string }>
	agents: Array<AccountConnectedAgentListItem>
	busy: boolean
	message: string | null
	draftName: string
	draftGrants: Array<{
		resourceId: string
		read: boolean
		execute: boolean
	}>
	onDraftName: (value: string) => void
	onTogglePackage: (packageId: string) => void
	onToggleAction: (
		packageId: string,
		action: 'read' | 'execute',
		enabled: boolean,
	) => void
	onCreate: () => void
	onDelete: (profileId: string) => void
}

export function renderConnectionProfilesPanel(
	state: ConnectionProfilesPanelState,
): RemixNode {
	const unlimitedAgents = state.agents.filter(
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
				{unlimitedAgents.length === 0 ? (
					<p mix={css(mutedCss)}>No unlimited connections yet.</p>
				) : (
					<ul mix={css(agentListCss)}>
						{unlimitedAgents.map((agent) => (
							<li key={agent.clientId}>{agent.label}</li>
						))}
					</ul>
				)}
			</div>

			<div mix={css(blockCss)}>
				<h2 mix={css(titleCss)}>Profiles</h2>
				<p mix={css(copyCss)}>
					A named profile only grants the packages you pick (read and/or
					execute). Paste the profile MCP URL into an agent; OAuth is unchanged.
					Profile names are at most {connectionProfileNameMaxLength} characters.
					“Unlimited” is reserved.
				</p>

				{state.profiles.length === 0 ? (
					<p mix={css(mutedCss)}>No profiles yet.</p>
				) : (
					<ul mix={css(profileListCss)}>
						{state.profiles.map((profile) => {
							const agents = state.agents.filter(
								(agent) => agent.connectionProfileName === profile.name,
							)
							return (
								<li key={profile.id} mix={css(profileItemCss)}>
									<div mix={css(profileHeaderCss)}>
										<strong>{profile.name}</strong>
										<button
											type="button"
											disabled={state.busy}
											data-testid={`connection-profile-delete-${profile.id}`}
											mix={[
												css(getGhostButtonCss({ size: 'sm' })),
												on('click', () => state.onDelete(profile.id)),
											]}
										>
											Delete
										</button>
									</div>
									{profile.mcpServerUrl ? (
										<CopyCard
											label="MCP URL"
											value={profile.mcpServerUrl}
											copyLabel="Copy MCP URL"
											variant="pill"
										/>
									) : null}
									<p mix={css(mutedCss)}>
										{profile.grants.length === 0
											? 'No package grants — this profile can see and run nothing.'
											: profile.grants
													.map((grant) => {
														const pkg = state.packageOptions.find(
															(option) => option.id === grant.resourceId,
														)
														const label = pkg?.name ?? grant.resourceId
														return `${label} (${grant.actions.join(', ')})`
													})
													.join(' · ')}
									</p>
									{agents.length > 0 ? (
										<ul mix={css(agentListCss)}>
											{agents.map((agent) => (
												<li key={agent.clientId}>{agent.label}</li>
											))}
										</ul>
									) : (
										<p mix={css(mutedCss)}>
											No agents connected with this profile.
										</p>
									)}
								</li>
							)
						})}
					</ul>
				)}

				<form
					data-testid="connection-profile-create"
					mix={[
						css(formCss),
						on('submit', (event) => {
							event.preventDefault()
							state.onCreate()
						}),
					]}
				>
					<h3 mix={css(subtitleCss)}>Add profile</h3>
					<label mix={css(labelCss)}>
						Name
						<input
							type="text"
							name="name"
							maxLength={connectionProfileNameMaxLength}
							value={state.draftName}
							disabled={state.busy}
							mix={on('input', (event) => {
								state.onDraftName(event.currentTarget.value)
							})}
						/>
					</label>
					<fieldset mix={css(fieldsetCss)} disabled={state.busy}>
						<legend>Packages</legend>
						{state.packageOptions.length === 0 ? (
							<p mix={css(mutedCss)}>Save a package first to grant it here.</p>
						) : (
							<ul mix={css(packageListCss)}>
								{state.packageOptions.map((pkg) => {
									const draft = state.draftGrants.find(
										(grant) => grant.resourceId === pkg.id,
									)
									const selected = Boolean(draft)
									return (
										<li key={pkg.id}>
											<label mix={css(packageRowCss)}>
												<input
													type="checkbox"
													checked={selected}
													mix={on('change', () => {
														state.onTogglePackage(pkg.id)
													})}
												/>
												<span>
													{pkg.name}
													<span mix={css(mutedCss)}> · {pkg.kodyId}</span>
												</span>
											</label>
											{selected ? (
												<div mix={css(actionsRowCss)}>
													<label>
														<input
															type="checkbox"
															checked={draft?.read === true}
															mix={on('change', (event) => {
																state.onToggleAction(
																	pkg.id,
																	'read',
																	event.currentTarget.checked,
																)
															})}
														/>{' '}
														read
													</label>
													<label>
														<input
															type="checkbox"
															checked={draft?.execute === true}
															mix={on('change', (event) => {
																state.onToggleAction(
																	pkg.id,
																	'execute',
																	event.currentTarget.checked,
																)
															})}
														/>{' '}
														execute
													</label>
												</div>
											) : null}
										</li>
									)
								})}
							</ul>
						)}
					</fieldset>
					{state.message ? <p mix={css(messageCss)}>{state.message}</p> : null}
					<button
						type="submit"
						disabled={state.busy}
						mix={css(getPillButtonCss({ size: 'sm' }))}
					>
						Create profile
					</button>
				</form>
			</div>
		</section>
	)
}

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

const profileItemCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.5rem',
}

const profileHeaderCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
}

const formCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.5rem',
}

const labelCss = {
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
}

const fieldsetCss = {
	margin: 0,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.5rem',
	display: 'grid',
	gap: spacing.sm,
}

const packageListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const packageRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
}

const actionsRowCss = {
	display: 'flex',
	gap: spacing.md,
	paddingInlineStart: spacing.xl,
	fontSize: typography.fontSize.sm,
}

const messageCss = {
	margin: 0,
	color: colors.danger,
	fontSize: typography.fontSize.sm,
}
