import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { MCPClientManager } from 'agents/mcp/client'
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	isStuckMcpAuthenticatingWithoutAuthUrl,
	resolveMcpOAuthCallbackOutcome,
} from './oauth-callback-outcome.ts'
import {
	type McpClientHubSnapshot,
	type McpServerConnectResult,
	type McpServerConnectionState,
	type McpServerOAuthCallbackOutcome,
	type McpServerSnapshot,
	type McpServerToolDescriptor,
} from './types.ts'

const mcpClientName = 'Kody'
const mcpClientVersion = '1.0.0'
const connectionSettleTimeoutMs = 8_000
const discoverTimeoutMs = 15_000

/**
 * Per-user Durable Object that owns the Agents SDK `MCPClientManager` for all
 * of that user's remote MCP servers. The DO id is derived from the stable MCP
 * `userId` (see `mcp-client-hub-key.ts` helpers in `hub-client.ts`), so
 * connections, OAuth client registrations, and tokens are isolated per user
 * inside this object's storage.
 */
class McpClientHubBase extends DurableObject<Env> {
	private manager: MCPClientManager
	private restored: Promise<void> | null = null

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		// The MCPClientManager persists registered servers in this table but
		// only the SDK Agent base class creates it; plain DOs must create it
		// themselves before constructing the manager.
		state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
				id TEXT PRIMARY KEY NOT NULL,
				name TEXT NOT NULL,
				server_url TEXT NOT NULL,
				callback_url TEXT NOT NULL,
				client_id TEXT,
				auth_url TEXT,
				server_options TEXT
			)
		`)
		// createAuthProvider mirrors Agent.addMcpServer so restore + OAuth
		// callback paths rebuild a DO-storage-backed provider after hibernation.
		this.manager = new MCPClientManager(mcpClientName, mcpClientVersion, {
			storage: state.storage,
			createAuthProvider: (callbackUrl) =>
				new DurableObjectOAuthClientProvider(
					state.storage,
					mcpClientName,
					callbackUrl,
				),
		})
	}

	private ensureRestored() {
		this.restored ??= this.manager.restoreConnectionsFromStorage(mcpClientName)
		return this.restored
	}

	private connectionStateFor(serverId: string): McpServerConnectionState {
		const connection = this.manager.mcpConnections[serverId]
		if (!connection) return 'disconnected'
		return connection.connectionState
	}

	private buildServerSnapshot(row: {
		id: string
		name: string
		server_url: string
		auth_url: string | null
	}): McpServerSnapshot {
		const connection = this.manager.mcpConnections[row.id]
		const state = this.connectionStateFor(row.id)
		const tools: McpServerSnapshot['tools'] =
			connection && state === 'ready'
				? connection.tools.map((tool) => ({
						name: tool.name,
						...(tool.title ? { title: tool.title } : {}),
						...(tool.description ? { description: tool.description } : {}),
						// Agents exposes a looser JSON-Schema-like inference than
						// JSONSchema7 / Tool['inputSchema']; values are plain JSON Schema.
						inputSchema:
							tool.inputSchema as McpServerToolDescriptor['inputSchema'],
						...(tool.outputSchema
							? {
									outputSchema:
										tool.outputSchema as McpServerToolDescriptor['outputSchema'],
								}
							: {}),
						...(tool.annotations ? { annotations: tool.annotations } : {}),
					}))
				: []
		return {
			serverId: row.id,
			name: row.name,
			url: row.server_url,
			state,
			authUrl: row.auth_url,
			error: connection?.connectionError ?? null,
			instructions: connection?.instructions ?? null,
			tools,
		}
	}

	private buildConnectResult(serverId: string): McpServerConnectResult {
		const row = this.manager
			.listServers()
			.find((server) => server.id === serverId)
		const snapshot = row
			? this.buildServerSnapshot(row)
			: {
					state: this.connectionStateFor(serverId),
					authUrl: null,
					error: null,
					tools: [],
				}
		return {
			serverId,
			state: snapshot.state,
			authUrl: snapshot.authUrl,
			error: snapshot.error,
			toolCount: snapshot.tools.length,
		}
	}

	/**
	 * Register a server and start connecting. For OAuth-protected servers the
	 * result is `state: "authenticating"` with an `authUrl` the user must
	 * open; `handleOAuthCallback` completes the flow.
	 */
	async addServer(input: {
		serverId: string
		name: string
		url: string
		callbackUrl: string
		/**
		 * Optional static request headers (for example Authorization: Bearer …).
		 * Persisted in the Agents SDK `server_options` blob alongside the server
		 * row; never returned in snapshots.
		 */
		headers?: Record<string, string>
	}): Promise<McpServerConnectResult> {
		await this.ensureRestored()
		const existing = this.manager.mcpConnections[input.serverId]
		if (existing) {
			await this.manager.removeServer(input.serverId)
		}
		// `registerServer` does not create an OAuth provider on its own (the SDK
		// Agent class builds one in `addMcpServer`), so build the same
		// DO-storage-backed provider here or OAuth servers can never surface an
		// authorization URL. The clientName must match the one passed to
		// `restoreConnectionsFromStorage` so storage keys line up after restarts.
		const authProvider = new DurableObjectOAuthClientProvider(
			this.ctx.storage,
			mcpClientName,
			input.callbackUrl,
		)
		authProvider.serverId = input.serverId
		await this.manager.registerServer(input.serverId, {
			url: input.url,
			name: input.name,
			callbackUrl: input.callbackUrl,
			transport: {
				type: 'auto',
				authProvider,
				...(input.headers ? { headers: input.headers } : {}),
			},
		})
		const result = await this.manager.connectToServer(input.serverId)
		if (result.state === 'connected') {
			await this.manager.discoverIfConnected(input.serverId, {
				timeoutMs: discoverTimeoutMs,
			})
		}
		return this.buildConnectResult(input.serverId)
	}

	/** Retry connecting to an already registered server. */
	async reconnectServer(input: {
		serverId: string
	}): Promise<McpServerConnectResult> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		const state = this.connectionStateFor(input.serverId)
		if (state === 'disconnected') {
			throw new Error(`MCP server "${input.serverId}" is not registered.`)
		}
		if (state !== 'ready' && state !== 'discovering') {
			const result = await this.manager.connectToServer(input.serverId)
			if (result.state === 'connected') {
				await this.manager.discoverIfConnected(input.serverId, {
					timeoutMs: discoverTimeoutMs,
				})
			}
		}
		const connected = this.buildConnectResult(input.serverId)
		if (isStuckMcpAuthenticatingWithoutAuthUrl(connected)) {
			return await this.recoverStuckAuthenticating(input.serverId)
		}
		return connected
	}

	/** Re-discover tools for a connected server. */
	async refreshServer(input: {
		serverId: string
	}): Promise<McpServerConnectResult> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		await this.manager.discoverIfConnected(input.serverId, {
			timeoutMs: discoverTimeoutMs,
		})
		return this.buildConnectResult(input.serverId)
	}

	async removeServer(input: { serverId: string }): Promise<void> {
		await this.ensureRestored()
		await this.manager.removeServer(input.serverId)
	}

	/**
	 * Complete an OAuth authorization redirect. The worker forwards the
	 * callback URL (including `code` and `state`) after authenticating the
	 * browser session that owns this hub.
	 *
	 * Success is reported only when the MCP connection reaches `ready`. The
	 * Agents SDK `authSuccess` flag alone is not enough: it can clear the
	 * stored auth URL and leave the connection in `authenticating` with no
	 * error after a provider (e.g. Clerk) authorization redirect.
	 */
	async handleOAuthCallback(input: {
		url: string
	}): Promise<McpServerOAuthCallbackOutcome> {
		await this.ensureRestored()
		const request = new Request(input.url, { method: 'GET' })
		if (!this.manager.isCallbackRequest(request)) {
			return {
				serverId: null,
				authSuccess: false,
				authError: 'This URL is not a pending MCP OAuth callback.',
				serverName: null,
			}
		}
		const result = await this.manager.handleCallbackRequest(request)
		const serverId = result.serverId ?? null
		const serverName = serverId
			? (this.manager.listServers().find((server) => server.id === serverId)
					?.name ?? null)
			: null
		if (result.authSuccess && serverId) {
			await this.manager.establishConnection(serverId)
			await this.manager.waitForConnections({
				timeout: connectionSettleTimeoutMs,
			})
			let connection = this.buildConnectResult(serverId)
			if (isStuckMcpAuthenticatingWithoutAuthUrl(connection)) {
				connection = await this.recoverStuckAuthenticating(serverId)
			}
			return resolveMcpOAuthCallbackOutcome({
				sdkAuthSuccess: true,
				sdkAuthError: result.authError ?? null,
				serverId,
				serverName,
				connection,
			})
		}
		return resolveMcpOAuthCallbackOutcome({
			sdkAuthSuccess: result.authSuccess,
			sdkAuthError: result.authError ?? null,
			serverId,
			serverName,
			connection: serverId ? this.buildConnectResult(serverId) : null,
		})
	}

	/**
	 * Clear unusable tokens and reconnect so the Agents SDK can mint a fresh
	 * auth URL. Needed when SQL `auth_url` was cleared on callback success but
	 * the live connection never reached `ready`.
	 */
	private async recoverStuckAuthenticating(
		serverId: string,
	): Promise<McpServerConnectResult> {
		const connection = this.manager.mcpConnections[serverId]
		const authProvider = connection?.options.transport.authProvider
		if (
			authProvider &&
			typeof authProvider.invalidateCredentials === 'function'
		) {
			try {
				await authProvider.invalidateCredentials('tokens')
			} catch {
				// Best-effort: reconnect below still regenerates OAuth when possible.
			}
		}
		const result = await this.manager.connectToServer(serverId)
		if (result.state === 'connected') {
			await this.manager.discoverIfConnected(serverId, {
				timeoutMs: discoverTimeoutMs,
			})
		}
		return this.buildConnectResult(serverId)
	}

	async getSnapshot(): Promise<McpClientHubSnapshot> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		return {
			servers: this.manager
				.listServers()
				.map((row) => this.buildServerSnapshot(row)),
		}
	}

	async callTool(input: {
		serverId: string
		toolName: string
		args: Record<string, unknown>
	}): Promise<CallToolResult> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		const state = this.connectionStateFor(input.serverId)
		if (state !== 'ready') {
			throw new Error(
				`MCP server "${input.serverId}" is not ready (state: ${state}).`,
			)
		}
		return (await this.manager.callTool({
			serverId: input.serverId,
			name: input.toolName,
			arguments: input.args,
		})) as CallToolResult
	}

	/** Close all connections and wipe stored servers, tokens, and OAuth state. */
	async purgeForAccountDeletion(): Promise<void> {
		try {
			await this.manager.closeAllConnections()
		} catch {
			// Connections that fail to close cleanly must not block deletion.
		}
		this.restored = null
		await this.ctx.storage.deleteAll()
	}
}

export const McpClientHub = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	McpClientHubBase,
)

export type McpClientHub = InstanceType<typeof McpClientHub>
