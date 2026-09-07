import { type Handle, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import {
	AccountManagementPanel,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
} from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { getDangerPillCss } from '#universal/styles/style-primitives.ts'

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
		render() {
			return (
				<AccountManagementPanel
					title="Connected agents"
					description="AI hosts that have authorized against this Kody account. Labels are best-effort from the host name or redirect."
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
					{agents.length > 0 ? (
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
							{agents.map((agent) => {
								const revokeCheck = getRevokeCheck(agent.clientId)
								return (
									<li
										key={agent.clientId}
										mix={css({
											display: 'flex',
											justifyContent: 'space-between',
											alignItems: 'center',
											gap: spacing.md,
											flexWrap: 'wrap',
										})}
									>
										<span mix={css({ display: 'grid', gap: spacing.xs })}>
											<span
												mix={css({
													fontWeight: typography.fontWeight.medium,
													color: colors.text,
												})}
											>
												{agent.label}
											</span>
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
													? `Confirm revoke ${agent.label}`
													: `Revoke ${agent.label}`
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
											{revokeCheck.doubleCheck ? 'Confirm revoke' : 'Revoke'}
										</button>
									</li>
								)
							})}
						</ul>
					) : (
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							No agents have authorized yet. Connect one from onboarding or your
							MCP host.
						</p>
					)}
				</AccountManagementPanel>
			)
		},
	}
}

const dangerButtonCss = getDangerPillCss({ size: 'sm' })
