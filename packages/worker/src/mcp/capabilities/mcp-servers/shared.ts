import { z } from 'zod'
import { normalizeMcpServerName } from '@kody-internal/shared/mcp-servers.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getCachedMcpClientHubSnapshot } from '#worker/mcp-client/hub-client.ts'
import { enrichMcpOAuthProviderError } from '#worker/mcp-client/oauth-provider-error.ts'
import {
	getMcpServerSettingById,
	listMcpServerSettings,
} from '#worker/mcp-client/settings-service.ts'
import { type McpServerSettingMetadata } from '#worker/mcp-client/settings-types.ts'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'

export const mcpServerStatusSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	enabled: z.boolean(),
	state: z.string(),
	connected: z.boolean(),
	toolCount: z.number().int().nonnegative(),
	authUrl: z.string().nullable(),
	error: z.string().nullable(),
	tools: z.array(z.string()),
	createdAt: z.string(),
	updatedAt: z.string(),
})

export type McpServerStatusView = z.infer<typeof mcpServerStatusSchema>

export function buildMcpServerStatusView(input: {
	setting: McpServerSettingMetadata
	snapshot: McpServerSnapshot | null
	oauthCallbackUrl?: string
	oauthClientOrigin?: string
}): McpServerStatusView {
	const { setting, snapshot } = input
	const connected = snapshot?.state === 'ready'
	const rawError = snapshot?.error ?? null
	const error =
		rawError && input.oauthCallbackUrl && input.oauthClientOrigin
			? enrichMcpOAuthProviderError(rawError, {
					callbackUrl: input.oauthCallbackUrl,
					clientOrigin: input.oauthClientOrigin,
				})
			: rawError
	return {
		id: setting.id,
		name: setting.name,
		url: setting.url,
		enabled: setting.enabled,
		state: snapshot?.state ?? 'disconnected',
		connected,
		toolCount: connected ? (snapshot?.tools.length ?? 0) : 0,
		authUrl: snapshot?.authUrl ?? null,
		error,
		tools: connected ? (snapshot?.tools.map((tool) => tool.name) ?? []) : [],
		createdAt: setting.createdAt,
		updatedAt: setting.updatedAt,
	}
}

export async function loadMcpClientHubSnapshotOrNull(input: {
	env: Env
	userId: string
}) {
	try {
		return await getCachedMcpClientHubSnapshot(input)
	} catch {
		return null
	}
}

/** Resolve a saved MCP server setting by exact id or (normalized) name. */
export async function resolveMcpServerSetting(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	server: string
}): Promise<McpServerSettingMetadata> {
	const identifier = input.server.trim()
	if (!identifier) {
		throw new McpCallerError('Provide the MCP server id or name in "server".')
	}
	const byId = await getMcpServerSettingById({
		env: input.env,
		userId: input.userId,
		id: identifier,
	})
	if (byId) return byId
	const settings = await listMcpServerSettings({
		env: input.env,
		userId: input.userId,
	})
	const normalized = normalizeMcpServerName(identifier)
	const byName = settings.find((setting) => setting.name === normalized)
	if (byName) return byName
	const available = settings.map((setting) => setting.name).join(', ') || 'none'
	// Unknown id/name is a caller mistake (stale name, typo). Keep it off Sentry.
	throw new McpCallerError(
		`No MCP server matches "${identifier}". Saved servers: ${available}.`,
	)
}
