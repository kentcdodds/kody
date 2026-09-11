import { type Handle, type RemixNode, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import {
	AccountManagementPanel,
	TimestampValue,
	accountActionsCss,
} from '#client/routes/account-management-components.tsx'
import {
	connectedAgentConnectionLabel,
	groupConnectedAgents,
} from '#universal/connected-mcp-agents.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
} from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getLogoWellCss,
} from '#universal/styles/style-primitives.ts'

export function createAccountConnectedAgents(handle: Handle) {
	let agents: Array<AccountConnectedAgentListItem> = []
	let busy = false
	let message: { text: string; tone: 'error' | 'info' } | null = null
	const revokeChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()

	function getRevokeCheck(clientId: string) {
		const existing = revokeChecks.get(clientId)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		revokeChecks.set(clientId, created)
		return created
	}

	function applyPayload(payload: AccountConnectedAgentsLoaderData) {
		agents = payload.agents
	}

	async function revokeAgent(clientId: string) {
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
				body: JSON.stringify({ intent: 'revoke', clientId }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountConnectedAgentsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to revoke this agent.')
			}
			agents = payload.agents
			revokeChecks.get(clientId)?.reset()
			message = { text: 'Agent disconnected.', tone: 'info' }
		} catch (error) {
			message = {
				text:
					error instanceof Error
						? error.message
						: 'Unable to revoke this agent.',
				tone: 'error',
			}
		} finally {
			busy = false
			handle.update()
		}
	}

	return {
		applyPayload,
		/** `actions` renders under the list (the Connections page puts Add connection there). */
		render(options?: { actions?: RemixNode }) {
			const groups = groupConnectedAgents(agents)
			return (
				<AccountManagementPanel
					title="Connected agents"
					description="AI hosts that have authorized against this Kody account. Same-named hosts are grouped. Labels are best-effort from the host name or redirect."
					ariaLabel="Connected agents"
				>
					{message ? (
						<p
							role="status"
							mix={css({
								color: message.tone === 'error' ? colors.error : colors.text,
								margin: 0,
							})}
						>
							{message.text}
						</p>
					) : null}
					{groups.length > 0 ? (
						<ul
							aria-busy={busy ? 'true' : undefined}
							mix={css({
								listStyle: 'none',
								padding: 0,
								margin: 0,
								display: 'grid',
								gap: spacing.md,
							})}
						>
							{groups.map((group) => (
								<li
									key={group.label}
									data-testid="connected-agent-group"
									data-agent-label={group.label}
								>
									<details mix={css(groupDetailsCss)}>
										<summary mix={css(groupSummaryCss)}>
											<ConnectedAgentMark icon={group.icon} />
											<span
												mix={css({
													fontWeight: typography.fontWeight.medium,
													color: colors.text,
												})}
											>
												{group.label}
											</span>
											{group.members.length > 1 ? (
												<>
													<span
														aria-hidden="true"
														mix={css({
															color: colors.textMuted,
															fontSize: typography.fontSize.sm,
														})}
													>
														({group.members.length})
													</span>
													<span class="visually-hidden">
														{`${group.members.length} connections`}
													</span>
												</>
											) : null}
											<span
												mix={css({
													color: colors.textMuted,
													fontSize: typography.fontSize.sm,
												})}
											>
												Connected{' '}
												<TimestampValue
													value={group.connectedAt}
													fallback="at an unknown time"
												/>
											</span>
										</summary>
										<ul
											mix={css({
												listStyle: 'none',
												padding: 0,
												margin: 0,
												display: 'grid',
												gap: spacing.sm,
											})}
										>
											{group.members.map((agent) => {
												const revokeCheck = getRevokeCheck(agent.clientId)
												const connectionLabel = connectedAgentConnectionLabel(
													agent.clientId,
												)
												const revokeName =
													group.members.length > 1
														? `${agent.label} (${connectionLabel})`
														: agent.label
												return (
													<li
														key={agent.clientId}
														data-testid="connected-agent-connection"
														data-client-id={agent.clientId}
														mix={css({
															display: 'flex',
															justifyContent: 'space-between',
															alignItems: 'center',
															gap: spacing.md,
															flexWrap: 'wrap',
															paddingInlineStart: spacing.lg,
														})}
													>
														<span
															mix={css({ display: 'grid', gap: spacing.xs })}
														>
															<code
																title={agent.clientId}
																mix={css({
																	color: colors.text,
																	fontSize: typography.fontSize.sm,
																	overflowWrap: 'anywhere',
																})}
															>
																{connectionLabel}
															</code>
															<span
																mix={css({
																	color: colors.textMuted,
																	fontSize: typography.fontSize.sm,
																})}
															>
																Connected{' '}
																<TimestampValue
																	value={agent.connectedAt}
																	fallback="at an unknown time"
																/>
															</span>
														</span>
														<button
															type="button"
															disabled={busy}
															aria-label={
																revokeCheck.doubleCheck
																	? `Confirm revoke ${revokeName}`
																	: `Revoke ${revokeName}`
															}
															mix={[
																css(dangerButtonCss),
																...revokeCheck.getButtonMix({
																	on: {
																		click: () => {
																			void revokeAgent(agent.clientId)
																		},
																	},
																}),
															]}
														>
															{revokeCheck.doubleCheck
																? 'Confirm revoke'
																: 'Revoke'}
														</button>
													</li>
												)
											})}
										</ul>
									</details>
								</li>
							))}
						</ul>
					) : (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No agents have authorized yet. Connect one from onboarding or your
							MCP host.
						</p>
					)}
					{options?.actions ? (
						<div mix={css(accountActionsCss)}>{options.actions}</div>
					) : null}
				</AccountManagementPanel>
			)
		},
	}
}

function ConnectedAgentMark(handle: Handle<{ icon: string | null }>) {
	return () => {
		if (!handle.props.icon) {
			return (
				<span
					aria-hidden="true"
					data-testid="connected-agent-mark-fallback"
					mix={css({
						display: 'grid',
						placeItems: 'center',
						flex: 'none',
						width: '1.75rem',
						height: '1.75rem',
						color: colors.textMuted,
					})}
				>
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="currentColor"
						aria-hidden="true"
					>
						<circle cx="6" cy="12" r="1.6" />
						<circle cx="12" cy="12" r="1.6" />
						<circle cx="18" cy="12" r="1.6" />
					</svg>
				</span>
			)
		}
		return (
			<span
				aria-hidden="true"
				mix={css(getLogoWellCss({ size: '1.75rem', radius: radius.md }))}
			>
				<img
					src={`/images/icons/${handle.props.icon}.svg`}
					alt=""
					width={20}
					height={20}
					mix={css({
						display: 'block',
						width: '1.15rem',
						height: '1.15rem',
						objectFit: 'contain',
					})}
				/>
			</span>
		)
	}
}

const groupDetailsCss = {
	'&[open] > summary': { marginBottom: spacing.sm },
}

const groupSummaryCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	cursor: 'pointer',
	flexWrap: 'wrap' as const,
}

const dangerButtonCss = getDangerPillCss({ size: 'sm' })
