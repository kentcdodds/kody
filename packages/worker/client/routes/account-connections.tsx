import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { createAccountConnectedAgents } from '#client/routes/account-connected-agents-panel.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from '#client/routes/account-management-components.tsx'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { docHref } from '#universal/docs-nav.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const connectYourAgentDocHref = docHref('connect-your-agent')

async function fetchConnectedAgents(signal: AbortSignal) {
	const response = await fetch(connectedAgentsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return { kind: 'unauthorized' as const }
	const payload = await readJson<AccountConnectedAgentsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load connections.')
	}
	return { kind: 'ok' as const, payload }
}

export async function accountConnectionsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await fetchConnectedAgents(signal)
	if (result.kind === 'unauthorized') {
		return routeLoaderRedirect('/login')
	}
	return { accountConnectedAgents: result.payload }
}

/**
 * `/account/connections` — the durable home for inbound MCP hosts: the MCP
 * URL to paste into another agent, the per-host setup guides, and the list of
 * agents that already authorized (grouped, per-`clientId` revoke). Sign-in
 * providers stay on Overview; outbound MCP servers stay on MCP servers.
 */
export function AccountConnectionsRoute(handle: Handle) {
	const connectedAgents = createAccountConnectedAgents(handle)
	let mcpServerUrl = ''
	let message: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedPayload: AccountConnectedAgentsLoaderData | null = null
	let appliedError: Error | null = null
	const connectionsData = createRouteData({
		key: 'accountConnectedAgents',
		async load(_href, signal) {
			const result = await fetchConnectedAgents(signal)
			if (result.kind === 'unauthorized') return routeDataRedirect('/login')
			return result.payload
		},
	})

	function applyPayload(payload: AccountConnectedAgentsLoaderData) {
		connectedAgents.applyPayload(payload)
		mcpServerUrl = payload.mcpServerUrl
		message = null
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = connectionsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyPayload(snapshot.data)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AccountPageHeader
					title="Connections"
					description="The agents connected to this Kody account, and how to connect another."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading connections…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<>
						<AccountManagementPanel
							title="Connect an agent"
							description="Every host reaches the same account through one MCP URL. Paste it into your agent, or open the setup guides for step-by-step instructions per host. The host will ask you to authorize afterwards."
							ariaLabel="Connect an agent"
						>
							{mcpServerUrl ? (
								<CopyCard
									label="MCP URL"
									value={mcpServerUrl}
									copyLabel="Copy MCP URL"
									variant="pill"
								/>
							) : (
								<p
									data-testid="account-connections-verify-note"
									mix={css({ color: colors.textMuted, margin: 0 })}
								>
									Verify your email to get this deployment&apos;s MCP URL. MCP
									access stays locked until the account email is verified.{' '}
									<a href={routes.pendingVerification.href()}>
										Verification page
									</a>
								</p>
							)}
							<div mix={css(accountActionsCss)}>
								<a
									href={routes.onboarding.href()}
									data-testid="account-connections-setup-guides"
									mix={css(compactGhostButtonCss)}
								>
									Setup guides by agent
								</a>
								<a
									href={connectYourAgentDocHref}
									mix={css(compactGhostButtonCss)}
								>
									Connect your agent docs
								</a>
							</div>
						</AccountManagementPanel>
						{connectedAgents.render()}
						<AccountManagementPanel
							title="Advanced"
							description="Optional tools for hosts that cannot finish dynamic OAuth on their own. This is not the list of agents already connected to your account."
						>
							<div mix={css(accountActionsCss)}>
								<a
									href={routes.accountMcpOauthClients.href()}
									mix={css(compactGhostButtonCss)}
								>
									MCP OAuth clients
								</a>
							</div>
						</AccountManagementPanel>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
