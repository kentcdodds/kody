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
	AgentPickerGrid,
	AgentSurfaceInstructions,
} from '#client/routes/onboarding-mcp-client-tabs.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type AccountConnectionsView,
	accountConnectionAgentIds,
	accountConnectionsNewHref,
	parseAccountConnectionsPathname,
} from '#universal/account-connections.ts'
import { docHref } from '#universal/docs-nav.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import {
	type McpClientKind,
	onboardingAgentLabel,
} from '#universal/onboarding-mcp-clients.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

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

/** The list, grid, and per-agent views all read one connected-agents payload. */
function connectionsLatchKey() {
	return routes.accountConnections.href()
}

function readView(href: string): AccountConnectionsView | null {
	return parseAccountConnectionsPathname(
		new URL(href, 'http://localhost').pathname,
	)
}

/**
 * `/account/connections` — the durable home for inbound MCP hosts. The
 * connected list is the same panel Overview used to host. Add connection
 * (`/new`) opens the full client wall from onboarding Step 1 with no
 * phone/desktop split and nothing folded under Not listed, and `/new/:agent`
 * shows that host's install steps. Sign-in providers stay on Overview;
 * outbound MCP servers stay on MCP servers.
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
		locationKey: connectionsLatchKey,
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
		const view = readView(currentHref)
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
		const adding = view?.kind === 'new'
		const selectedAgent = view?.kind === 'new' ? view.agent : null

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
						{connectedAgents.render({
							actions: adding ? null : (
								<a
									href={accountConnectionsNewHref(null)}
									data-testid="account-connections-add"
									mix={css(primaryButtonCss)}
								>
									Add connection
								</a>
							),
						})}
						{view === null ? renderUnknownAgent() : null}
						{adding && selectedAgent === null
							? renderAgentGrid({ mcpServerUrl })
							: null}
						{selectedAgent
							? renderAgentInstructions({ agent: selectedAgent, mcpServerUrl })
							: null}
						{!adding ? renderMcpUrlPanel({ mcpServerUrl }) : null}
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

function renderVerifyNote() {
	return (
		<p
			data-testid="account-connections-verify-note"
			mix={css({ color: colors.textMuted, margin: 0 })}
		>
			Verify your email to get this deployment&apos;s MCP URL. MCP access stays
			locked until the account email is verified.{' '}
			<a href={routes.pendingVerification.href()}>Verification page</a>
		</p>
	)
}

function renderMcpUrlPanel(input: { mcpServerUrl: string }) {
	return (
		<AccountManagementPanel
			title="MCP URL"
			description="Every host reaches the same account through one MCP URL. Add connection walks through a specific agent; any other agent that speaks MCP can paste this URL and approve the Kody OAuth window."
			ariaLabel="MCP URL"
		>
			{input.mcpServerUrl ? (
				<CopyCard
					label="MCP URL"
					value={input.mcpServerUrl}
					copyLabel="Copy MCP URL"
					variant="pill"
				/>
			) : (
				renderVerifyNote()
			)}
			<div mix={css(accountActionsCss)}>
				<a href={connectYourAgentDocHref} mix={css(compactGhostButtonCss)}>
					Connect your agent docs
				</a>
			</div>
		</AccountManagementPanel>
	)
}

function renderAgentGrid(input: { mcpServerUrl: string }) {
	return (
		<AccountManagementPanel
			title="Add connection"
			description="Pick the agent you want to connect. Every agent Kody knows how to connect is listed here, on every device; the next step shows that host's install path."
			ariaLabel="Add connection"
		>
			{input.mcpServerUrl ? (
				<div
					data-testid="account-connections-agent-grid"
					mix={css({ display: 'grid', gap: spacing.lg })}
				>
					<span class="visually-hidden" id="account-connections-add-title">
						Agents you can connect
					</span>
					<AgentPickerGrid
						ids={accountConnectionAgentIds.map((id) => ({
							id,
							viewport: 'both' as const,
						}))}
						labelledBy="account-connections-add-title"
						agentHref={(agent) => accountConnectionsNewHref(agent)}
					/>
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						<p mix={css({ color: colors.textMuted, margin: 0 })}>
							Using something else? Any agent that speaks MCP connects with this
							URL. Approve the Kody OAuth window when the host opens it.
						</p>
						<CopyCard
							label="MCP URL"
							value={input.mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
					</div>
				</div>
			) : (
				renderVerifyNote()
			)}
		</AccountManagementPanel>
	)
}

function renderAgentInstructions(input: {
	agent: McpClientKind
	mcpServerUrl: string
}) {
	const label = onboardingAgentLabel(input.agent)
	return (
		<AccountManagementPanel
			title={`Connect ${label}`}
			description="Follow the steps for this host, then approve the Kody OAuth window when it opens. The new connection appears in the list above once the host authorizes."
			ariaLabel={`Connect ${label}`}
		>
			<div mix={css(accountActionsCss)}>
				<a
					href={accountConnectionsNewHref(null)}
					data-testid="account-connections-change-agent"
					mix={css(compactGhostButtonCss)}
				>
					Change agent
				</a>
			</div>
			{input.mcpServerUrl ? (
				<div
					data-testid="account-connections-agent-instructions"
					data-agent={input.agent}
					mix={css({ display: 'grid', gap: spacing.lg })}
				>
					<AgentSurfaceInstructions
						agent={input.agent}
						mcpServerUrl={input.mcpServerUrl}
					/>
				</div>
			) : (
				renderVerifyNote()
			)}
		</AccountManagementPanel>
	)
}

function renderUnknownAgent() {
	return (
		<AccountManagementPanel
			title="Unknown agent"
			description="That agent is not one Kody knows how to connect. Pick one from the list, or use the MCP URL with any host that speaks MCP."
		>
			<div mix={css(accountActionsCss)}>
				<a
					href={accountConnectionsNewHref(null)}
					mix={css(compactGhostButtonCss)}
				>
					Choose an agent
				</a>
			</div>
		</AccountManagementPanel>
	)
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const primaryButtonCss = {
	...getPillButtonCss({ size: 'sm' }),
	textDecoration: 'none',
	width: 'fit-content',
}
