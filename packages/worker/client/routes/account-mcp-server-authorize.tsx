import { type Handle, css } from 'remix/component'
import { type McpOAuthClientMode } from '@kody-internal/shared/mcp-servers.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
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
	MetadataGrid,
} from '#client/routes/account-management-components.tsx'
import { type McpServerAuthorizeLoaderData } from '#universal/loader-data.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

/**
 * The consent page is always a full document load so the form token and the
 * pending authorization come from the server, never from a client cache.
 */
export async function accountMcpServerAuthorizeRouteLoader(
	url: URL,
): Promise<RouteLoaderResult> {
	return routeLoaderRedirect(`${url.pathname}${url.search}`)
}

function clientModeCopy(mode: McpOAuthClientMode) {
	switch (mode) {
		case 'cimd':
			return {
				label: 'Client ID Metadata Document (CIMD)',
				detail:
					'Kody identifies itself with its published client metadata document.',
			}
		case 'dcr':
			return {
				label: 'Dynamic Client Registration (DCR)',
				detail: 'Kody registered itself with this authorization server.',
			}
		default: {
			const exhaustive: never = mode
			throw new Error(`Unhandled MCP OAuth client mode: ${String(exhaustive)}`)
		}
	}
}

const codeCss = {
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
} as const

const noteCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} as const

export function AccountMcpServerAuthorizeRoute(handle: Handle) {
	let data: McpServerAuthorizeLoaderData | null = null

	return () => {
		const href = readCurrentRouterHref(handle)
		const consumed = tryConsumeRouteLoaderData(
			handle,
			'mcpServerAuthorize',
			href,
		)
		if (consumed) data = consumed
		if (!data) {
			return (
				<AccountManagementShell maxWidth="40rem">
					<AccountPageHeader
						title="Authorize MCP server"
						description="Loading the authorization details…"
						currentHref={href}
					/>
				</AccountManagementShell>
			)
		}
		const { pending } = data
		const mode = pending ? clientModeCopy(pending.clientMode) : null
		return (
			<AccountManagementShell maxWidth="40rem">
				<AccountPageHeader
					title={`Authorize ${data.serverName}`}
					description="Review where Kody is sending you before you approve access. Nothing is approved until you click Continue."
					currentHref={href}
				/>
				{data.error ? (
					<AccountManagementMessage tone="error">
						{data.error}
					</AccountManagementMessage>
				) : null}
				{pending && mode ? (
					<AccountManagementPanel
						title="Review this connection"
						description={`Continue opens ${pending.authorizationServerHost}. After you approve there, you come back to Kody and this server's tools become available to this organization.`}
					>
						<MetadataGrid
							items={[
								{
									label: 'MCP server',
									value: (
										<span data-testid="mcp-authorize-server-name">
											{data.serverName}
										</span>
									),
								},
								{
									label: 'Server URL',
									value: <code mix={css(codeCss)}>{data.serverUrl}</code>,
								},
								{
									label: 'Authorization server',
									value: (
										<code data-testid="mcp-authorize-host" mix={css(codeCss)}>
											{pending.authorizationServerHost}
										</code>
									),
								},
								{
									label: 'Client mode',
									value: (
										<span data-testid="mcp-authorize-client-mode">
											{mode.label}
										</span>
									),
								},
							]}
						/>
						<p mix={css(noteCss)}>{mode.detail}</p>
						<form
							method="post"
							action={new URL(href, 'http://localhost').pathname}
							rel="noreferrer"
							data-router-skip
							mix={css(accountActionsCss)}
						>
							<input type="hidden" name="_csrf" value={pending.csrfToken} />
							<button
								type="submit"
								data-testid="mcp-authorize-continue"
								mix={css(getPillButtonCss({ size: 'sm' }))}
							>
								Continue to {pending.authorizationServerHost}
							</button>
							<a
								href={data.serverHref}
								mix={css({
									...getGhostButtonCss({ size: 'sm' }),
									textDecoration: 'none',
								})}
							>
								Cancel
							</a>
						</form>
					</AccountManagementPanel>
				) : (
					<AccountManagementPanel title="Nothing to approve">
						<p mix={css({ margin: 0, color: colors.text })}>
							{data.serverName} is not waiting for approval. Open the server and
							click Reconnect to start a new authorization.
						</p>
						<div mix={css(accountActionsCss)}>
							<a
								href={data.serverHref}
								mix={css({
									...getPillButtonCss({ size: 'sm' }),
									textDecoration: 'none',
								})}
							>
								Open {data.serverName}
							</a>
						</div>
					</AccountManagementPanel>
				)}
			</AccountManagementShell>
		)
	}
}
