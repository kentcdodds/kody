import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { MCPClientManager } from 'agents/mcp/client'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	createMcpClientOAuthProvider,
	mcpClientName,
} from './client-id-metadata.ts'
import {
	isStuckMcpAuthenticatingWithoutAuthUrl,
	resolveMcpOAuthCallbackOutcome,
} from './oauth-callback-outcome.ts'
import {
	createInitialMcpConnectionEpisode,
	mcpConnectionEpisodeStorageKey,
	mcpConnectionEventsPendingStorageKey,
	mcpLightweightReconnectAttempts,
	mcpLightweightReconnectBackoffMs,
	mcpLightweightReconnectDiscoverTimeoutMs,
	observeMcpConnectionState,
	type McpConnectionEpisodeRecord,
	type McpServerConnectionEvent,
} from './connection-episodes.ts'
import {
	type McpClientHubSnapshot,
	type McpServerConnectResult,
	type McpServerConnectionState,
	type McpServerOAuthCallbackOutcome,
	type McpServerSnapshot,
	type McpServerToolDescriptor,
} from './types.ts'

const mcpClientVersion = '1.0.0'
const connectionSettleTimeoutMs = 8_000
const discoverTimeoutMs = 15_000
const oauthRecoveryMessage =
	'Authorization needed. Reconnect the MCP server and approve access once more.'

export function extractMcpServerIdFromOAuthState(state: string | null) {
	if (!state) return null
	const parts = state.split('.')
	if (parts.length !== 2) return null
	return parts[1] || null
}

export function isRecoverableMcpOAuthStateError(error: string | null) {
	if (!error) return false
	const normalized = error.toLowerCase()
	return (
		normalized.includes('state not found') ||
		normalized.includes('already used') ||
		normalized.includes('state expired') ||
		normalized.includes('invalid state') ||
		normalized.includes('no state provided')
	)
}

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
				createMcpClientOAuthProvider(state.storage, callbackUrl),
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
		const authProvider = createMcpClientOAuthProvider(
			this.ctx.storage,
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
		const connected = await this.manager.connectToServer(input.serverId)
		if (connected.state === 'connected') {
			await this.manager.discoverIfConnected(input.serverId, {
				timeoutMs: discoverTimeoutMs,
			})
		}
		await this.observeServer({
			serverId: input.serverId,
			serverName: input.name,
		})
		return this.buildConnectResult(input.serverId)
	}

	/**
	 * Restart a saved server with the deployment's current OAuth callback.
	 *
	 * Re-registering the local connection clears pending state and PKCE values,
	 * so every reconnect gets a fresh authorization URL. A callback change also
	 * drops the stored dynamic client registration, forcing DCR to advertise the
	 * current redirect URI while preserving the saved server row in D1.
	 */
	async reconnectServer(input: {
		serverId: string
		callbackUrl: string
	}): Promise<McpServerConnectResult> {
		await this.ensureRestored()
		await this.manager.waitForConnections({
			timeout: connectionSettleTimeoutMs,
		})
		await this.restartServerAuthorization(input)
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (row) {
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
		}
		return this.buildConnectResult(input.serverId)
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
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (row) {
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
		}
		return this.buildConnectResult(input.serverId)
	}

	async removeServer(input: { serverId: string }): Promise<void> {
		await this.ensureRestored()
		await this.manager.removeServer(input.serverId)
		await this.ctx.storage.delete(
			mcpConnectionEpisodeStorageKey(input.serverId),
		)
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
		callbackUrl: string
	}): Promise<McpServerOAuthCallbackOutcome> {
		await this.ensureRestored()
		const request = new Request(input.url, { method: 'GET' })
		const stateServerId = extractMcpServerIdFromOAuthState(
			new URL(request.url).searchParams.get('state'),
		)
		if (!this.manager.isCallbackRequest(request)) {
			if (
				stateServerId &&
				this.manager.listServers().some((server) => server.id === stateServerId)
			) {
				return await this.restartAfterUnusableCallback({
					serverId: stateServerId,
					callbackUrl: input.callbackUrl,
				})
			}
			const pendingServers = this.manager
				.listServers()
				.filter((server) => Boolean(server.auth_url))
			if (pendingServers.length === 1 && pendingServers[0]) {
				return await this.restartAfterUnusableCallback({
					serverId: pendingServers[0].id,
					callbackUrl: input.callbackUrl,
				})
			}
			return {
				serverId: null,
				authSuccess: false,
				authError: oauthRecoveryMessage,
				serverName: null,
				authorizationNeeded: true,
			}
		}
		const result = await this.manager.handleCallbackRequest(request)
		const serverId = result.serverId ?? null
		const serverName = serverId
			? (this.manager.listServers().find((server) => server.id === serverId)
					?.name ?? null)
			: null
		if (
			serverId &&
			!result.authSuccess &&
			isRecoverableMcpOAuthStateError(result.authError ?? null)
		) {
			return await this.restartAfterUnusableCallback({
				serverId,
				callbackUrl: input.callbackUrl,
			})
		}
		if (result.authSuccess && serverId) {
			await this.manager.establishConnection(serverId)
			await this.manager.waitForConnections({
				timeout: connectionSettleTimeoutMs,
			})
			let connection = this.buildConnectResult(serverId)
			if (isStuckMcpAuthenticatingWithoutAuthUrl(connection)) {
				connection = await this.recoverStuckAuthenticating(serverId)
			}
			if (serverName) {
				await this.observeServer({
					serverId,
					serverName,
				})
			}
			return resolveMcpOAuthCallbackOutcome({
				sdkAuthSuccess: true,
				sdkAuthError: result.authError ?? null,
				serverId,
				serverName,
				connection: this.buildConnectResult(serverId),
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

	private async restartAfterUnusableCallback(input: {
		serverId: string
		callbackUrl: string
	}): Promise<McpServerOAuthCallbackOutcome> {
		const serverName =
			this.manager.listServers().find((server) => server.id === input.serverId)
				?.name ?? null
		const existingConnection = this.buildConnectResult(input.serverId)
		if (existingConnection.state === 'ready') {
			return resolveMcpOAuthCallbackOutcome({
				sdkAuthSuccess: true,
				sdkAuthError: null,
				serverId: input.serverId,
				serverName,
				connection: existingConnection,
			})
		}
		if (
			existingConnection.state === 'connected' ||
			existingConnection.state === 'discovering' ||
			existingConnection.state === 'connecting'
		) {
			return {
				serverId: input.serverId,
				authSuccess: true,
				authError: null,
				serverName,
				authorizationNeeded: false,
			}
		}
		try {
			const connection = await this.restartServerAuthorization(input)
			if (connection.state === 'ready') {
				return {
					serverId: input.serverId,
					authSuccess: true,
					authError: null,
					serverName,
					authorizationNeeded: false,
				}
			}
		} catch {
			// The account page offers Reconnect if automatic recovery fails.
		}
		return {
			serverId: input.serverId,
			authSuccess: false,
			authError: oauthRecoveryMessage,
			serverName,
			authorizationNeeded: true,
		}
	}

	private async restartServerAuthorization(input: {
		serverId: string
		callbackUrl: string
	}): Promise<McpServerConnectResult> {
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (!row) {
			throw new Error(`MCP server "${input.serverId}" is not registered.`)
		}

		const existingConnection = this.manager.mcpConnections[input.serverId]
		const existingOptions = existingConnection?.options
		const callbackChanged = row.callback_url !== input.callbackUrl
		const clientId = callbackChanged ? null : row.client_id
		const oauthStoragePrefix = `/${mcpClientName}/${input.serverId}/`
		const oauthStorageSnapshot = await this.ctx.storage.list({
			prefix: oauthStoragePrefix,
		})

		try {
			await this.manager.removeServer(input.serverId)
			await this.clearOAuthAuthorizationStorage({
				serverId: input.serverId,
				clearClientRegistration: callbackChanged,
			})

			const authProvider = createMcpClientOAuthProvider(
				this.ctx.storage,
				input.callbackUrl,
			)
			authProvider.serverId = input.serverId
			if (clientId) authProvider.clientId = clientId

			await this.manager.registerServer(input.serverId, {
				url: row.server_url,
				name: row.name,
				callbackUrl: input.callbackUrl,
				...(clientId ? { clientId } : {}),
				...(existingOptions?.client ? { client: existingOptions.client } : {}),
				transport: {
					...existingOptions?.transport,
					type: existingOptions?.transport.type ?? 'auto',
					authProvider,
				},
			})
		} catch (error) {
			await this.manager.removeServer(input.serverId).catch(() => {})
			if (oauthStorageSnapshot.size > 0) {
				await this.ctx.storage
					.put(Object.fromEntries(oauthStorageSnapshot))
					.catch(() => {})
			}

			const originalAuthProvider = createMcpClientOAuthProvider(
				this.ctx.storage,
				row.callback_url,
			)
			originalAuthProvider.serverId = input.serverId
			if (row.client_id) originalAuthProvider.clientId = row.client_id
			await this.manager
				.registerServer(input.serverId, {
					url: row.server_url,
					name: row.name,
					callbackUrl: row.callback_url,
					...(row.client_id ? { clientId: row.client_id } : {}),
					...(row.auth_url ? { authUrl: row.auth_url } : {}),
					...(existingOptions?.client
						? { client: existingOptions.client }
						: {}),
					transport: {
						...existingOptions?.transport,
						type: existingOptions?.transport.type ?? 'auto',
						authProvider: originalAuthProvider,
					},
				})
				.catch(() => {})
			throw error
		}
		const result = await this.manager.connectToServer(input.serverId)
		if (result.state === 'connected') {
			await this.manager.discoverIfConnected(input.serverId, {
				timeoutMs: discoverTimeoutMs,
			})
		}
		return this.buildConnectResult(input.serverId)
	}

	private async clearOAuthAuthorizationStorage(input: {
		serverId: string
		clearClientRegistration: boolean
	}) {
		const prefix = `/${mcpClientName}/${input.serverId}/`
		const entries = await this.ctx.storage.list({ prefix })
		const keys = [...entries.keys()].filter((key) => {
			if (input.clearClientRegistration) return true
			return !key.endsWith('/client_info/') && !key.endsWith('/oauth_discovery')
		})
		if (keys.length > 0) {
			await this.ctx.storage.delete(keys)
		}
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
		for (const row of this.manager.listServers()) {
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
		}
		return {
			servers: this.manager
				.listServers()
				.map((row) => this.buildServerSnapshot(row)),
			connectionEvents: await this.takeConnectionEvents(),
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
		const row = this.manager
			.listServers()
			.find((server) => server.id === input.serverId)
		if (row) {
			await this.observeServer({
				serverId: row.id,
				serverName: row.name,
			})
		}
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

	async takeConnectionEvents(): Promise<Array<McpServerConnectionEvent>> {
		const events =
			(await this.ctx.storage.get<Array<McpServerConnectionEvent>>(
				mcpConnectionEventsPendingStorageKey,
			)) ?? []
		if (events.length > 0) {
			await this.ctx.storage.delete(mcpConnectionEventsPendingStorageKey)
		}
		return events
	}

	private async readEpisode(
		serverId: string,
	): Promise<McpConnectionEpisodeRecord> {
		return (
			(await this.ctx.storage.get<McpConnectionEpisodeRecord>(
				mcpConnectionEpisodeStorageKey(serverId),
			)) ?? createInitialMcpConnectionEpisode()
		)
	}

	private async writeEpisode(
		serverId: string,
		episode: McpConnectionEpisodeRecord,
		event?: McpServerConnectionEvent,
	) {
		const entries: Record<string, unknown> = {
			[mcpConnectionEpisodeStorageKey(serverId)]: episode,
		}
		if (event) {
			const existing =
				(await this.ctx.storage.get<Array<McpServerConnectionEvent>>(
					mcpConnectionEventsPendingStorageKey,
				)) ?? []
			entries[mcpConnectionEventsPendingStorageKey] = [...existing, event]
		}
		await this.ctx.storage.put(entries)
	}

	private async lightweightReconnectServer(serverId: string) {
		const connected = await this.manager.connectToServer(serverId)
		if (connected.state === 'connected') {
			await this.manager.discoverIfConnected(serverId, {
				timeoutMs: mcpLightweightReconnectDiscoverTimeoutMs,
			})
		}
		return this.buildConnectResult(serverId)
	}

	private async recoverUnavailableServer(serverId: string) {
		for (
			let attempt = 0;
			attempt < mcpLightweightReconnectAttempts;
			attempt++
		) {
			if (attempt > 0) {
				const backoffMs = mcpLightweightReconnectBackoffMs[attempt - 1] ?? 0
				if (backoffMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, backoffMs))
				}
			}
			try {
				const result = await this.lightweightReconnectServer(serverId)
				if (result.state === 'ready' || result.state === 'authenticating') {
					return
				}
			} catch {
				// The next attempt (or the observe pass) records the still-down state.
			}
		}
	}

	private async observeServer(input: { serverId: string; serverName: string }) {
		const previous = await this.readEpisode(input.serverId)
		const first = observeMcpConnectionState({
			previous,
			currentState: this.connectionStateFor(input.serverId),
			retryCompleted: false,
			createEpisodeId: () => crypto.randomUUID(),
		})
		let decision = first
		if (first.shouldRetry) {
			await this.writeEpisode(input.serverId, first.next)
			await this.recoverUnavailableServer(input.serverId)
			decision = observeMcpConnectionState({
				previous: first.next,
				currentState: this.connectionStateFor(input.serverId),
				retryCompleted: true,
				createEpisodeId: () => crypto.randomUUID(),
			})
		}
		await this.writeEpisode(
			input.serverId,
			decision.next,
			decision.event
				? {
						topic: decision.event.topic,
						eventId: crypto.randomUUID(),
						episodeId: decision.event.episodeId,
						serverId: input.serverId,
						serverName: input.serverName,
						state: this.connectionStateFor(input.serverId),
						previousState: decision.event.previousState,
						observedAt: new Date().toISOString(),
					}
				: undefined,
		)
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
