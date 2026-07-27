import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { normalizeRemoteConnectorInstanceId } from '@kody-internal/shared/remote-connectors.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type RemoteConnectorHelloMessage,
	type RemoteConnectorJsonRpcResponse,
	type RemoteConnectorPersistedState,
	type RemoteConnectorSessionExport,
	type RemoteConnectorServerMessage,
	type RemoteConnectorSnapshot,
} from './types.ts'
import {
	createJsonRpcRequest,
	parseRemoteConnectorMessage,
	stringifyRemoteConnectorMessage,
} from './utils.ts'
import { userScopedConnectorSessionKey } from './connector-session-key.ts'
import {
	hasRemoteConnectorSharedSecret,
	remoteConnectorSharedSecretMatches,
} from './resolve-remote-connector-secret.ts'

const connectorTag = 'connector'
const stateStorageKey = 'remote-connector-session-state'
const rpcTimeoutMs = 15_000

const remoteConnectorToolsListRpcErrorName = 'RemoteConnectorToolsListRpcError'

function isExpectedToolsSnapshotRefreshFailure(error: unknown) {
	if (
		error instanceof Error &&
		error.name === remoteConnectorToolsListRpcErrorName
	) {
		return true
	}
	const message = getErrorMessage(error)
	return (
		message === 'No remote connector is connected.' ||
		message.startsWith('Timed out waiting for remote connector response to ') ||
		message.includes(' before RPC response.')
	)
}

type PendingRpcRequest = {
	resolve: (message: RemoteConnectorJsonRpcResponse) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

type RemoteConnectorSessionState = {
	persisted: RemoteConnectorPersistedState
	tools: Array<RemoteConnectorSnapshot['tools'][number]>
}

function summarizeSessionKey(value: string | null) {
	if (!value) {
		return null
	}
	return {
		length: value.length,
		present: true,
	}
}

class RemoteConnectorSessionBase extends DurableObject<Env> {
	private stateSnapshot: RemoteConnectorSessionState = {
		persisted: {
			connectorId: null,
			description: null,
			connectedAt: null,
			lastSeenAt: null,
		},
		tools: [],
	}

	private ingressSessionKeys = new WeakMap<WebSocket, string | null>()

	private ingressUserIds = new WeakMap<WebSocket, string | null>()

	private disconnectedSockets = new WeakSet<WebSocket>()

	private pendingRequests = new Map<string, PendingRpcRequest>()

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		state.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	private clearConnectionState() {
		this.stateSnapshot.persisted.connectedAt = null
		this.stateSnapshot.tools = []
	}

	private rejectPendingRequests(reason: string) {
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout)
			pending.reject(new Error(`${reason} requestId=${id}`))
		}
		this.pendingRequests.clear()
	}

	private captureSessionMessage(
		message: string,
		input: {
			level?: 'warning' | 'error'
			/** Owning user for the socket/event that triggered this capture. */
			userId?: string | null
			extra?: Record<string, unknown>
		} = {},
	) {
		const connectorId =
			typeof input.extra?.connectorId === 'string'
				? input.extra.connectorId
				: (this.stateSnapshot.persisted.connectorId ?? undefined)
		const userId = input.userId ?? null
		Sentry.withScope((scope) => {
			scope.setLevel(input.level ?? 'warning')
			scope.setTag('service', 'worker')
			scope.setTag('worker_component', 'remote-connector-session')
			if (connectorId) {
				scope.setTag('remote_connector.id', connectorId)
			}
			if (userId) {
				scope.setUser({ id: userId })
			}
			scope.setContext('remote_connector', {
				connectorId: connectorId ?? null,
				userId,
				connected: this.ctx.getWebSockets(connectorTag).length > 0,
				...input.extra,
			})
			Sentry.captureMessage(message)
		})
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			const sessionKeyHeader = request.headers
				.get('X-Kody-Connector-Session-Key')
				?.trim()
			const userIdHeader = request.headers
				.get('X-Kody-Connector-User-Id')
				?.trim()
			return this.handleWebSocketUpgrade(
				sessionKeyHeader || null,
				userIdHeader || null,
			)
		}
		return new Response('Not Found', { status: 404 })
	}

	webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): void | Promise<void> {
		return this.handleWebSocketMessage(ws, message)
	}

	webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void> {
		return this.handleDisconnect(ws, { code, reason, wasClean })
	}

	webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		return this.handleDisconnect(ws, {
			code: 1011,
			reason: error instanceof Error ? error.message : String(error ?? 'error'),
			wasClean: false,
		})
	}

	private async handleDisconnect(
		ws: WebSocket,
		close: {
			code: number
			reason: string
			wasClean: boolean
		},
	) {
		if (this.disconnectedSockets.has(ws)) return
		this.disconnectedSockets.add(ws)

		const { code, reason, wasClean } = close
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		const activeSockets = this.ctx
			.getWebSockets(connectorTag)
			.filter((socket) => socket !== ws)
		if (activeSockets.length === 0) {
			this.clearConnectionState()
			this.rejectPendingRequests(
				`Remote connector websocket closed code=${code} wasClean=${wasClean}${reason ? ` reason=${reason}` : ''} before RPC response.`,
			)
		}
		// Disconnects are expected lifecycle noise for remote connectors
		// (laptop sleep, process restart, flaky home networks, DO migration).
		// Keep an ops log line; do not open Sentry issues. Auth failures and
		// message-handler bugs already capture at error level above.
		console.warn(
			`Remote connector session websocket closed code=${code} wasClean=${wasClean}${reason ? ` reason=${reason}` : ''}`,
		)
		return this.persistState()
	}

	async getConnectorId() {
		return this.stateSnapshot.persisted.connectorId
	}

	async rpcListTools() {
		const response = await this.sendRpcRequest('tools/list', {})
		if ('error' in response) {
			throw new Error(response.error.message)
		}
		return (
			(
				response.result as {
					tools?: Array<RemoteConnectorSnapshot['tools'][number]>
				}
			).tools ?? []
		)
	}

	async rpcCallTool(name: string, args: Record<string, unknown>) {
		const response = await this.sendRpcRequest('tools/call', {
			name,
			arguments: args,
		})
		if ('error' in response) {
			throw new Error(response.error.message)
		}
		return response.result
	}

	async forwardJsonRpc(message: JSONRPCMessage) {
		if ('method' in message) {
			return this.sendRpcRequest(
				message.method,
				(message.params ?? {}) as Record<string, unknown>,
			)
		}
		return null
	}

	async getSnapshot(): Promise<RemoteConnectorSnapshot | null> {
		const { connectorId, description, connectedAt, lastSeenAt } =
			this.stateSnapshot.persisted
		if (!connectorId || !connectedAt || !lastSeenAt) return null
		if (this.ctx.getWebSockets(connectorTag).length === 0) {
			return null
		}
		return {
			connectorKind: connectorId,
			connectorId,
			...(description ? { description } : {}),
			connectedAt,
			lastSeenAt,
			tools: this.stateSnapshot.tools,
		}
	}

	async rpcExportUserSession(input: {
		userId: string
		instanceId: string
	}): Promise<RemoteConnectorSessionExport> {
		const sessionKey = userScopedConnectorSessionKey(input)
		if (!sessionKey) {
			throw new Error('Remote connector session key was invalid.')
		}
		return {
			persisted: { ...this.stateSnapshot.persisted },
			tools: this.stateSnapshot.tools.map((tool) => ({ ...tool })),
			connected: this.ctx.getWebSockets(connectorTag).length > 0,
		}
	}

	async rpcExportUserSessionPage(input: {
		userId: string
		instanceId: string
		pageSize: number
		startAfter?: string
	}) {
		const sessionKey = userScopedConnectorSessionKey(input)
		if (!sessionKey) {
			throw new Error('Remote connector session key was invalid.')
		}
		const start = input.startAfter
			? Math.max(0, Number.parseInt(input.startAfter, 10))
			: 0
		const pageSize = Math.min(Math.max(input.pageSize, 1), 500)
		const tools = this.stateSnapshot.tools.slice(start, start + pageSize)
		const next = start + tools.length
		const truncated = next < this.stateSnapshot.tools.length
		return {
			persisted: { ...this.stateSnapshot.persisted },
			tools: tools.map((tool) => ({ ...tool })),
			connected: this.ctx.getWebSockets(connectorTag).length > 0,
			truncated,
			nextStartAfter: truncated ? String(next) : null,
			pageSize,
		}
	}

	async rpcPurgeUserSession(input: { userId: string; instanceId: string }) {
		const sessionKey = userScopedConnectorSessionKey(input)
		if (!sessionKey) {
			throw new Error('Remote connector session key was invalid.')
		}
		this.rejectPendingRequests('Remote connector session purged')
		for (const socket of this.ctx.getWebSockets(connectorTag)) {
			try {
				socket.close(1000, 'account-deleted')
			} catch {
				// Ignore sockets that are already closing.
			}
		}
		this.clearConnectionState()
		await this.ctx.storage.deleteAll()
		return {
			ok: true as const,
		}
	}

	private async restoreState() {
		const stored =
			await this.ctx.storage.get<RemoteConnectorSessionState>(stateStorageKey)
		if (!stored) return
		if (stored.persisted.description === undefined) {
			stored.persisted.description = null
		}
		this.stateSnapshot = stored
	}

	private async persistState() {
		await this.ctx.storage.put(stateStorageKey, this.stateSnapshot)
	}

	private async handleWebSocketUpgrade(
		ingressSessionKey: string | null,
		ingressUserId: string | null,
	) {
		const pair = new WebSocketPair()
		const sockets = Object.values(pair)
		const client = sockets[0]
		const server = sockets[1]
		if (!client || !server) {
			throw new Error('Failed to create WebSocket pair.')
		}
		this.ctx.acceptWebSocket(server, [connectorTag])
		this.stashIngressSessionKey(server, ingressSessionKey, ingressUserId)
		server.send(
			stringifyRemoteConnectorMessage({
				type: 'server.ping',
			}),
		)
		return new Response(null, {
			status: 101,
			webSocket: client,
		})
	}

	private async handleWebSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	) {
		let parsed: RemoteConnectorServerMessage
		try {
			parsed = parseRemoteConnectorMessage(message)
		} catch (error) {
			this.captureSessionMessage(
				'Remote connector session received invalid websocket payload.',
				{
					level: 'error',
					userId: this.loadIngressUserId(ws),
					extra: {
						connectorId: this.stateSnapshot.persisted.connectorId,
						error: getErrorMessage(error),
					},
				},
			)
			ws.send(
				stringifyRemoteConnectorMessage({
					type: 'server.error',
					message: getErrorMessage(error),
				}),
			)
			return
		}

		try {
			switch (parsed.type) {
				case 'connector.hello':
					await this.handleHello(ws, parsed)
					return
				case 'connector.heartbeat':
					await this.handleHeartbeat()
					return
				case 'connector.jsonrpc':
					await this.handleJsonRpcMessage(parsed.message)
					return
			}
		} catch (error) {
			this.captureSessionMessage(
				'Remote connector session message handler threw.',
				{
					level: 'error',
					userId: this.loadIngressUserId(ws),
					extra: {
						connectorId: this.stateSnapshot.persisted.connectorId,
						messageType: parsed.type,
						error: getErrorMessage(error),
					},
				},
			)
			try {
				ws.send(
					stringifyRemoteConnectorMessage({
						type: 'server.error',
						message: getErrorMessage(error),
					}),
				)
			} catch {
				// Ignore send failures while we're already handling a websocket error.
			}
			return
		}
	}

	private rejectHelloSharedSecretLookupFailure(input: {
		ws: WebSocket
		connectorId: string
		userId: string
		error: unknown
	}) {
		const detail = getErrorMessage(input.error)
		if (isRetryableD1LockError(input.error)) {
			// Same class as other D1 blips already dropped from Sentry: keep an
			// ops warn, ask the connector to reconnect, and do not report a
			// false "invalid shared secret" auth failure.
			console.warn(
				`Remote connector shared-secret lookup failed during websocket hello (transient D1). connectorId=${input.connectorId} error=${detail}`,
			)
			input.ws.send(
				stringifyRemoteConnectorMessage({
					type: 'server.error',
					message:
						'Connector authentication temporarily unavailable. Retry shortly.',
				}),
			)
			input.ws.close(1013, 'secret-lookup-retry')
			return
		}
		this.captureSessionMessage(
			'Remote connector session failed shared-secret lookup for websocket hello.',
			{
				level: 'error',
				userId: input.userId,
				extra: {
					connectorId: input.connectorId,
					error: detail,
				},
			},
		)
		input.ws.send(
			stringifyRemoteConnectorMessage({
				type: 'server.error',
				message:
					'Connector authentication temporarily unavailable. Retry shortly.',
			}),
		)
		input.ws.close(1011, 'secret-lookup-failed')
	}

	private async handleHello(
		ws: WebSocket,
		message: RemoteConnectorHelloMessage,
	) {
		const canonicalInstanceId = normalizeRemoteConnectorInstanceId(
			message.connectorId,
		)
		const ingressUserId = this.loadIngressUserId(ws)
		if (!ingressUserId) {
			this.captureSessionMessage(
				'Remote connector session rejected hello (missing user id on ingress).',
				{
					level: 'error',
					userId: null,
					extra: {
						connectorId: canonicalInstanceId,
					},
				},
			)
			ws.send(
				stringifyRemoteConnectorMessage({
					type: 'server.error',
					message:
						'Connector ingress is missing the owning user id. Reconfigure the connector to use the /@{username}/connectors/{instanceId} URL.',
				}),
			)
			ws.close(4002, 'missing-user')
			return
		}
		const expectedSessionKey = userScopedConnectorSessionKey({
			userId: ingressUserId,
			instanceId: canonicalInstanceId,
		})
		const ingressSessionKey = this.loadIngressSessionKey(ws)
		if (ingressSessionKey && ingressSessionKey !== expectedSessionKey) {
			this.captureSessionMessage(
				'Remote connector session rejected hello (session key mismatch).',
				{
					level: 'error',
					userId: ingressUserId,
					extra: {
						connectorId: canonicalInstanceId,
						ingressSessionKeySummary: summarizeSessionKey(ingressSessionKey),
						expectedSessionKeySummary: summarizeSessionKey(expectedSessionKey),
						sessionKeyMatch: false,
					},
				},
			)
			ws.send(
				stringifyRemoteConnectorMessage({
					type: 'server.error',
					message: 'Connector session key does not match this endpoint.',
				}),
			)
			ws.close(4003, 'session-mismatch')
			return
		}

		let secretMatches: boolean
		try {
			secretMatches = await remoteConnectorSharedSecretMatches({
				userId: ingressUserId,
				instanceId: canonicalInstanceId,
				sharedSecret: message.sharedSecret,
				env: this.env,
			})
		} catch (error) {
			this.rejectHelloSharedSecretLookupFailure({
				ws,
				connectorId: canonicalInstanceId,
				userId: ingressUserId,
				error,
			})
			return
		}
		if (!secretMatches) {
			let hasExpectedSecret: boolean
			try {
				hasExpectedSecret = await hasRemoteConnectorSharedSecret({
					userId: ingressUserId,
					instanceId: canonicalInstanceId,
					env: this.env,
				})
			} catch (error) {
				this.rejectHelloSharedSecretLookupFailure({
					ws,
					connectorId: canonicalInstanceId,
					userId: ingressUserId,
					error,
				})
				return
			}
			this.captureSessionMessage(
				'Remote connector session rejected websocket hello.',
				{
					level: 'error',
					userId: ingressUserId,
					extra: {
						connectorId: canonicalInstanceId,
						hasExpectedSecret,
					},
				},
			)
			ws.send(
				stringifyRemoteConnectorMessage({
					type: 'server.error',
					message: 'Invalid connector shared secret.',
				}),
			)
			ws.close(4001, 'invalid-secret')
			return
		}

		const now = new Date().toISOString()
		this.stateSnapshot.persisted = {
			connectorId: canonicalInstanceId,
			description: message.description?.trim() || null,
			connectedAt: this.stateSnapshot.persisted.connectedAt ?? now,
			lastSeenAt: now,
		}
		await this.persistState()
		ws.send(
			stringifyRemoteConnectorMessage({
				type: 'server.ack',
				connectorId: canonicalInstanceId,
			}),
		)
		try {
			await this.refreshToolsSnapshot()
		} catch (error) {
			await this.handleToolsSnapshotRefreshFailure({
				phase: 'after websocket hello',
				error,
			})
		}
	}

	private async handleHeartbeat() {
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		await this.persistState()
	}

	private async handleJsonRpcMessage(message: JSONRPCMessage) {
		if ('result' in message || 'error' in message) {
			const pending = this.pendingRequests.get(String(message.id))
			if (!pending) return
			clearTimeout(pending.timeout)
			this.pendingRequests.delete(String(message.id))
			pending.resolve(message)
			return
		}
		if (
			'method' in message &&
			message.method === 'notifications/tools/list_changed'
		) {
			try {
				await this.refreshToolsSnapshot()
			} catch (error) {
				await this.handleToolsSnapshotRefreshFailure({
					phase: 'on tools/list_changed',
					error,
				})
			}
		}
	}

	private async handleToolsSnapshotRefreshFailure(input: {
		phase: 'after websocket hello' | 'on tools/list_changed'
		error: unknown
	}) {
		if (!isExpectedToolsSnapshotRefreshFailure(input.error)) {
			// Malformed tools/list payloads, storage failures, and other
			// implementation bugs should still open Sentry via the outer
			// message-handler catch — do not clear a still-valid tool cache.
			throw input.error
		}
		// Timeouts, disconnects mid-RPC, and "not connected" are expected
		// remote-connector lifecycle noise (same class as websocket closes).
		// Soft-fail by clearing tools; keep an ops log line and do not open
		// Sentry issues. Restore the in-memory cache if persistence fails so
		// later reads are not left empty while Sentry captures the storage bug.
		const previousTools = this.stateSnapshot.tools
		this.stateSnapshot.tools = []
		console.warn(
			`Remote connector tools snapshot refresh failed ${input.phase}. connectorId=${this.stateSnapshot.persisted.connectorId ?? 'null'} error=${getErrorMessage(input.error)}`,
		)
		try {
			await this.persistState()
		} catch (persistError) {
			this.stateSnapshot.tools = previousTools
			throw persistError
		}
	}

	private async refreshToolsSnapshot() {
		const response = await this.sendRpcRequest('tools/list', {})
		if ('error' in response) {
			const error = new Error(response.error.message)
			error.name = remoteConnectorToolsListRpcErrorName
			throw error
		}
		const result = response.result
		if (
			result === null ||
			typeof result !== 'object' ||
			Array.isArray(result)
		) {
			throw new Error('Malformed tools/list result.')
		}
		const tools = (result as { tools?: unknown }).tools
		if (tools !== undefined && !Array.isArray(tools)) {
			throw new Error('Malformed tools/list tools.')
		}
		this.stateSnapshot.tools =
			(tools as Array<RemoteConnectorSnapshot['tools'][number]> | undefined) ??
			[]
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		await this.persistState()
	}

	private async sendRpcRequest(
		method: string,
		params: Record<string, unknown>,
	): Promise<RemoteConnectorJsonRpcResponse> {
		const socket = this.ctx.getWebSockets(connectorTag)[0]
		if (!socket) {
			throw new Error('No remote connector is connected.')
		}

		const id = crypto.randomUUID()
		const request = createJsonRpcRequest(id, method, params)

		const response = await new Promise<RemoteConnectorJsonRpcResponse>(
			(resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pendingRequests.delete(id)
					reject(
						new Error(
							`Timed out waiting for remote connector response to ${method}.`,
						),
					)
				}, rpcTimeoutMs)
				this.pendingRequests.set(id, {
					resolve,
					reject,
					timeout,
				})
				socket.send(
					stringifyRemoteConnectorMessage({
						type: 'connector.jsonrpc',
						message: request,
					}),
				)
			},
		)

		return response
	}

	private stashIngressSessionKey(
		ws: WebSocket,
		ingressSessionKey: string | null,
		ingressUserId: string | null,
	) {
		this.ingressSessionKeys.set(ws, ingressSessionKey)
		this.ingressUserIds.set(ws, ingressUserId)
		try {
			ws.serializeAttachment({
				ingressSessionKey: ingressSessionKey ?? '',
				ingressUserId: ingressUserId ?? '',
			})
		} catch {
			// No attachment support; keep in-memory map only.
		}
	}

	private loadIngressAttachment(ws: WebSocket): {
		ingressSessionKey: string | null
		ingressUserId: string | null
	} {
		try {
			const attachment = ws.deserializeAttachment() as unknown
			if (attachment && typeof attachment === 'object') {
				const record = attachment as Record<string, unknown>
				const sessionKey =
					typeof record.ingressSessionKey === 'string'
						? record.ingressSessionKey
						: null
				const userId =
					typeof record.ingressUserId === 'string' ? record.ingressUserId : null
				return {
					ingressSessionKey: sessionKey || null,
					ingressUserId: userId || null,
				}
			}
		} catch {
			// Ignore deserialization errors, we only enforce if we have a key.
		}
		return { ingressSessionKey: null, ingressUserId: null }
	}

	private loadIngressSessionKey(ws: WebSocket): string | null {
		if (this.ingressSessionKeys.has(ws)) {
			return this.ingressSessionKeys.get(ws) ?? null
		}
		const { ingressSessionKey, ingressUserId } = this.loadIngressAttachment(ws)
		this.ingressSessionKeys.set(ws, ingressSessionKey)
		if (!this.ingressUserIds.has(ws)) {
			this.ingressUserIds.set(ws, ingressUserId)
		}
		return ingressSessionKey
	}

	private loadIngressUserId(ws: WebSocket): string | null {
		if (this.ingressUserIds.has(ws)) {
			return this.ingressUserIds.get(ws) ?? null
		}
		const { ingressSessionKey, ingressUserId } = this.loadIngressAttachment(ws)
		this.ingressUserIds.set(ws, ingressUserId)
		if (!this.ingressSessionKeys.has(ws)) {
			this.ingressSessionKeys.set(ws, ingressSessionKey)
		}
		return ingressUserId
	}
}

export const RemoteConnectorSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RemoteConnectorSessionBase,
)

export type RemoteConnectorSession = InstanceType<typeof RemoteConnectorSession>
