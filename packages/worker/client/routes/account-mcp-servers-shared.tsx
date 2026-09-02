import { css } from 'remix/ui'
import { ProviderMark } from '#client/provider-icons.tsx'
import { isMcpOAuthAllowlistRejection } from '#universal/mcp-oauth-provider-error.ts'
import { recordCellClamp } from '#client/routes/record-table.tsx'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

const clampedCellCss = css(recordCellClamp(26))

export function hostFromUrl(url: string | null | undefined) {
	if (!url) return null
	try {
		return new URL(url).hostname || null
	} catch {
		return null
	}
}

export function renderNamedServer(input: {
	name: string
	url: string
	autoLogoPath?: string | null
	catalogLogoPath?: string | null
}) {
	return (
		<span
			mix={css({
				display: 'inline-flex',
				alignItems: 'center',
				gap: spacing.sm,
				minWidth: 0,
			})}
		>
			<ProviderMark
				providerKey={input.name}
				label={input.name}
				autoLogoPath={input.autoLogoPath}
				catalogLogoPath={input.catalogLogoPath}
				host={hostFromUrl(input.url)}
				size="1.75rem"
			/>
			<span mix={clampedCellCss}>{input.name}</span>
		</span>
	)
}

export type McpServerListItem = {
	id: string
	name: string
	url: string
	enabled: boolean
	state: string
	connected: boolean
	toolCount: number
	authUrl: string | null
	error: string | null
	tools: Array<string>
	createdAt: string
	updatedAt: string
	autoLogoPath: string | null
	catalogLogoPath: string | null
	usageMode: 'any' | 'packages'
	allowedPackageIds: Array<string>
}

export type AccountMcpServersPayload = {
	ok: true
	email: string
	username: string
	oauthClientOrigin: string
	oauthCallbackUrl: string
	oauthClientMetadataUrl: string | null
	servers: Array<McpServerListItem>
	savedPackages: Array<{ id: string; kodyId: string }>
	selectedServerId?: string
}

export type MessageTone = 'info' | 'error'

export type McpServerUsageDraft = {
	usageMode: 'any' | 'packages'
	allowedPackageIds: Array<string>
}

export function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

export function filterServers(
	servers: Array<McpServerListItem>,
	search: string,
) {
	return servers.filter((server) =>
		matchesSearchQuery(search, [
			server.name,
			server.url,
			server.state,
			server.error,
			server.usageMode,
		]),
	)
}

export function stateLabel(
	server: Pick<McpServerListItem, 'state' | 'enabled'>,
) {
	if (!server.enabled) return 'Disabled'
	switch (server.state) {
		case 'ready':
			return 'Connected'
		case 'authenticating':
			return 'Authorization required'
		case 'connecting':
			return 'Connecting'
		case 'connected':
		case 'discovering':
			return 'Discovering tools'
		case 'failed':
			return 'Connection failed'
		default:
			return 'Disconnected'
	}
}

export function stateColor(
	server: Pick<McpServerListItem, 'state' | 'enabled'>,
) {
	if (!server.enabled) return colors.textMuted
	switch (server.state) {
		case 'ready':
			return colors.primary
		case 'failed':
			return colors.error
		case 'authenticating':
			return colors.textMuted
		default:
			return colors.textMuted
	}
}

export function readOAuthResultFromHref(href: string): {
	message: string
	tone: MessageTone
} | null {
	const url = new URL(href, 'http://localhost')
	const auth = url.searchParams.get('auth')
	if (auth === 'success') {
		const server = url.searchParams.get('server')
		return {
			message: server
				? `Authorized MCP server "${server}".`
				: 'Authorized MCP server.',
			tone: 'info',
		}
	}
	if (auth === 'required') {
		return {
			message:
				'Authorization needed. Open the new authorization link and approve access once more.',
			tone: 'info',
		}
	}
	if (auth === 'retry') {
		return {
			message:
				'That authorization attempt can no longer be used. Choose the server and click Reconnect to try again.',
			tone: 'info',
		}
	}
	if (auth === 'error') {
		const reason = url.searchParams.get('reason')
		if (reason && isMcpOAuthAllowlistRejection(reason)) {
			return {
				message: reason,
				tone: 'error',
			}
		}
		return {
			message: reason
				? `MCP server authorization failed: ${reason}`
				: 'MCP server authorization failed.',
			tone: 'error',
		}
	}
	return null
}
