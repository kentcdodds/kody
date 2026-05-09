import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type RemoteConnectorHelloMessage,
	type RemoteConnectorJsonRpcResponse,
	type RemoteConnectorPersistedState,
	type RemoteConnectorServerMessage,
	type RemoteConnectorSnapshot,
} from './types.ts'
import {
	createJsonRpcRequest,
	parseRemoteConnectorMessage,
	stringifyRemoteConnectorMessage,
} from './utils.ts'
import { connectorSessionKey } from './connector-session-key.ts'
import {
	hasRemoteConnectorSharedSecret,
	remoteConnectorSharedSecretMatches,
} from './resolve-remote-connector-secret.ts'

const connectorTag = 'connector'
const stateStorageKey = 'remote-connector-session-state'
const rpcTimeoutMs = 15_000

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
			connectorKind: null,
			description: null,
			connectedAt: null,
			lastSeenAt: null,
		},
		tools: [],
	}

	private ingressSessionKeys = new WeakMap<WebSocket, string | null>()

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
			extra?: Record<string, unknown>
		} = {},
	) {
		Sentry.captureMessage(message, {
			level: input.level ?? 'warning',
			tags: {
				service: 'worker',
				worker_component: 'remote-connector-session',
			},
			extra: input.extra ?? {},
		})
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			const sessionKeyHeader = request.headers
				.get('X-Kody-Connector-Session-Key')
				?.trim()
			return this.handleWebSocketUpgrade(sessionKeyHeader || null)
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
		const closeMessage = `Remote connector session websocket closed code=${code} wasClean=${wasClean}${reason ? ` reason=${reason}` : ''}`
		console.warn(closeMessage)
		this.captureSessionMessage(closeMessage, {
			level: 'warning',
			extra: {
				code,
				reason,
				wasClean,
				connectorId: this.stateSnapshot.persisted.connectorId,
			},
		})
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
		const { connectorId, connectorKind, description, connectedAt, lastSeenAt } =
			this.stateSnapshot.persisted
		if (!connectorId || !connectedAt || !lastSeenAt) return null
		if (this.ctx.getWebSockets(connectorTag).length === 0) {
			return null
		}
		const kind = (connectorKind && connectorKind.trim()) || 'unknown'
		return {
			connectorKind: kind,
			connectorId,
			...(description ? { description } : {}),
			connectedAt,
			lastSeenAt,
			tools: this.stateSnapshot.tools,
		}
	}

	private async restoreState() {
		const stored =
			await this.ctx.storage.get<RemoteConnectorSessionState>(stateStorageKey)
		if (!stored) return
		if (stored.persisted.connectorKind === undefined) {
			stored.persisted.connectorKind = null
		}
		if (stored.persisted.description === undefined) {
			stored.persisted.description = null
		}
		this.stateSnapshot = stored
	}

	private async persistState() {
		await this.ctx.storage.put(stateStorageKey, this.stateSnapshot)
	}

	private async handleWebSocketUpgrade(ingressSessionKey: string | null) {
		const pair = new WebSocketPair()
		const sockets = Object.values(pair)
		const client = sockets[0]
		const server = sockets[1]
		if (!client || !server) {
			throw new Error('Failed to create WebSocket pair.')
		}
		this.ctx.acceptWebSocket(server, [connectorTag])
		this.stashIngressSessionKey(server, ingressSessionKey)
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
					extra: {
						connectorId: this.stateSnapshot.persisted.connectorId,
						error: error instanceof Error ? error.message : String(error),
					},
				},
			)
			ws.send(
				stringifyRemoteConnectorMessage({
					type: 'server.error',
					message: error instanceof Error ? error.message : String(error),
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
					extra: {
						connectorId: this.stateSnapshot.persisted.connectorId,
						messageType: parsed.type,
						error: error instanceof Error ? error.message : String(error),
					},
				},
			)
			try {
				ws.send(
					stringifyRemoteConnectorMessage({
						type: 'server.error',
						message: error instanceof Error ? error.message : String(error),
					}),
				)
			} catch {
				// Ignore send failures while we're already handling a websocket error.
			}
			return
		}
	}

	private async handleHello(
		ws: WebSocket,
		message: RemoteConnectorHelloMessage,
	) {
		const declaredKind = message.connectorKind.trim().toLowerCase()
		const canonicalInstanceId = message.connectorId.trim()
		const expectedSessionKey = connectorSessionKey(
			declaredKind,
			canonicalInstanceId,
		)
		const ingressSessionKey = this.loadIngressSessionKey(ws)
		if (ingressSessionKey && ingressSessionKey !== expectedSessionKey) {
			this.captureSessionMessage(
				'Remote connector session rejected hello (session key mismatch).',
				{
					level: 'error',
					extra: {
						connectorId: canonicalInstanceId,
						declaredKind,
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

		const secretMatches = await remoteConnectorSharedSecretMatches({
			kind: declaredKind,
			instanceId: canonicalInstanceId,
			sharedSecret: message.sharedSecret,
			env: this.env,
		})
		if (!secretMatches) {
			const hasExpectedSecret = await hasRemoteConnectorSharedSecret({
				kind: declaredKind,
				instanceId: canonicalInstanceId,
				env: this.env,
			})
			this.captureSessionMessage(
				'Remote connector session rejected websocket hello.',
				{
					level: 'error',
					extra: {
						connectorId: canonicalInstanceId,
						declaredKind,
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
			connectorKind: declaredKind,
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
			this.stateSnapshot.tools = []
			this.captureSessionMessage(
				'Remote connector tools snapshot refresh failed after websocket hello.',
				{
					level: 'error',
					extra: {
						connectorId: this.stateSnapshot.persisted.connectorId,
						error: error instanceof Error ? error.message : String(error),
					},
				},
			)
			await this.persistState()
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
				this.stateSnapshot.tools = []
				this.captureSessionMessage(
					'Remote connector tools snapshot refresh failed.',
					{
						level: 'error',
						extra: {
							connectorId: this.stateSnapshot.persisted.connectorId,
							error: error instanceof Error ? error.message : String(error),
						},
					},
				)
				await this.persistState()
				return
			}
		}
	}

	private async refreshToolsSnapshot() {
		const response = await this.sendRpcRequest('tools/list', {})
		if ('error' in response) {
			throw new Error(response.error.message)
		}
		const result = response.result as {
			tools?: Array<RemoteConnectorSnapshot['tools'][number]>
		}
		this.stateSnapshot.tools = result.tools ?? []
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		await this.persistState()
	}

	private async sendRpcRequest(
		method: string,
		params: Record<string, unknown>,
	): Promise<RemoteConnectorJsonRpcResponse> {
		const socket = this.ctx.getWebSockets(connectorTag)[0]
		if (!socket) {
			throw new Error('No remote connector is currently connected.')
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
	) {
		this.ingressSessionKeys.set(ws, ingressSessionKey)
		try {
			ws.serializeAttachment(ingressSessionKey ?? '')
		} catch {
			// No attachment support; keep in-memory map only.
		}
	}

	private loadIngressSessionKey(ws: WebSocket): string | null {
		if (this.ingressSessionKeys.has(ws)) {
			return this.ingressSessionKeys.get(ws) ?? null
		}
		let ingressSessionKey: string | null = null
		try {
			const attachment = ws.deserializeAttachment()
			if (typeof attachment === 'string') {
				ingressSessionKey = attachment || null
			}
		} catch {
			// Ignore deserialization errors, we only enforce if we have a key.
		}
		this.ingressSessionKeys.set(ws, ingressSessionKey)
		return ingressSessionKey
	}
}

export const RemoteConnectorSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RemoteConnectorSessionBase,
)

export type RemoteConnectorSession = InstanceType<typeof RemoteConnectorSession>
