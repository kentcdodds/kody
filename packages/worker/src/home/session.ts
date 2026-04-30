import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type HomeConnectorHelloMessage,
	type HomeConnectorJsonRpcResponse,
	type HomeConnectorPersistedState,
	type HomeConnectorServerMessage,
	type HomeConnectorSnapshot,
} from './types.ts'
import {
	createJsonRpcRequest,
	parseHomeConnectorMessage,
	parseJsonRpcMessage,
	jsonResponse,
	stringifyHomeConnectorMessage,
} from './utils.ts'
import { connectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { resolveRemoteConnectorSharedSecret } from '#worker/remote-connector/resolve-remote-connector-secret.ts'

const connectorTag = 'connector'
const stateStorageKey = 'home-connector-session-state'
const rpcTimeoutMs = 15_000

type PendingRpcRequest = {
	resolve: (message: HomeConnectorJsonRpcResponse) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

type HomeConnectorSessionState = {
	persisted: HomeConnectorPersistedState
	tools: Array<HomeConnectorSnapshot['tools'][number]>
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

class HomeConnectorSessionBase extends DurableObject<Env> {
	private stateSnapshot: HomeConnectorSessionState = {
		persisted: {
			connectorId: null,
			connectorKind: null,
			connectedAt: null,
			lastSeenAt: null,
		},
		tools: [],
	}

	private ingressSessionKeys = new WeakMap<WebSocket, string | null>()

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
				worker_component: 'home-connector-session',
			},
			extra: input.extra ?? {},
		})
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.headers.get('Upgrade') === 'websocket') {
			const sessionKeyHeader = request.headers
				.get('X-Kody-Connector-Session-Key')
				?.trim()
			return this.handleWebSocketUpgrade(sessionKeyHeader || null)
		}
		if (request.method === 'GET' && url.pathname.endsWith('/snapshot')) {
			return jsonResponse(await this.getSnapshot())
		}
		if (request.method === 'POST' && url.pathname.endsWith('/rpc/tools-list')) {
			const response = await this.sendRpcRequest('tools/list', {})
			if ('error' in response) {
				return new Response(response.error.message, { status: 502 })
			}
			return jsonResponse(response.result)
		}
		if (request.method === 'POST' && url.pathname.endsWith('/rpc/tools-call')) {
			const body = (await request.json()) as {
				name: string
				arguments?: Record<string, unknown>
			}
			const response = await this.sendRpcRequest('tools/call', {
				name: body.name,
				arguments: body.arguments ?? {},
			})
			if ('error' in response) {
				return new Response(response.error.message, { status: 502 })
			}
			return jsonResponse(response.result)
		}
		if (request.method === 'POST' && url.pathname.endsWith('/rpc/jsonrpc')) {
			const body = (await request.json()) as {
				message?: JSONRPCMessage
			}
			if (!body.message) {
				return new Response('Missing JSON-RPC message.', { status: 400 })
			}
			const response = await this.forwardJsonRpc(body.message)
			return jsonResponse(response)
		}
		return new Response('Not found', { status: 404 })
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
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		const activeSockets = this.ctx
			.getWebSockets(connectorTag)
			.filter((socket) => socket !== ws)
		if (activeSockets.length === 0) {
			this.clearConnectionState()
			this.rejectPendingRequests(
				`Home connector websocket closed code=${code} wasClean=${wasClean}${reason ? ` reason=${reason}` : ''} before RPC response.`,
			)
		}
		const closeMessage = `Home connector session websocket closed code=${code} wasClean=${wasClean}${reason ? ` reason=${reason}` : ''}`
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

	webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		const reason =
			error instanceof Error ? error.message : String(error ?? 'error')
		return this.webSocketClose(ws, 1011, reason, false)
	}

	async getConnectorId() {
		return this.stateSnapshot.persisted.connectorId
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

	async getSnapshot(): Promise<HomeConnectorSnapshot | null> {
		const { connectorId, connectorKind, connectedAt, lastSeenAt } =
			this.stateSnapshot.persisted
		if (!connectorId || !connectedAt || !lastSeenAt) return null
		if (this.ctx.getWebSockets(connectorTag).length === 0) {
			return null
		}
		const kind = (connectorKind && connectorKind.trim()) || ('home' as const)
		return {
			...(kind !== 'home' ? { connectorKind: kind } : {}),
			connectorId,
			connectedAt,
			lastSeenAt,
			tools: this.stateSnapshot.tools,
		}
	}

	private async restoreState() {
		const stored =
			await this.ctx.storage.get<HomeConnectorSessionState>(stateStorageKey)
		if (!stored) return
		if (stored.persisted.connectorKind === undefined) {
			stored.persisted.connectorKind = null
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
			stringifyHomeConnectorMessage({
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
		let parsed: HomeConnectorServerMessage
		try {
			parsed = parseHomeConnectorMessage(message)
		} catch (error) {
			this.captureSessionMessage(
				'Home connector session received invalid websocket payload.',
				{
					level: 'error',
					extra: {
						connectorId: this.stateSnapshot.persisted.connectorId,
						error: error instanceof Error ? error.message : String(error),
					},
				},
			)
			ws.send(
				stringifyHomeConnectorMessage({
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
				'Home connector session message handler threw.',
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
					stringifyHomeConnectorMessage({
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

	private async handleHello(ws: WebSocket, message: HomeConnectorHelloMessage) {
		const trimmedKind = (message.connectorKind ?? '').trim()
		const declaredKind = (
			trimmedKind === '' ? 'home' : trimmedKind
		).toLowerCase()
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
				stringifyHomeConnectorMessage({
					type: 'server.error',
					message: 'Connector session key does not match this endpoint.',
				}),
			)
			ws.close(4003, 'session-mismatch')
			return
		}

		const expectedSecret = resolveRemoteConnectorSharedSecret(
			declaredKind,
			canonicalInstanceId,
			this.env,
		)
		if (!expectedSecret || message.sharedSecret !== expectedSecret) {
			this.captureSessionMessage(
				'Home connector session rejected websocket hello.',
				{
					level: 'error',
					extra: {
						connectorId: canonicalInstanceId,
						declaredKind,
						hasExpectedSecret: Boolean(expectedSecret),
					},
				},
			)
			ws.send(
				stringifyHomeConnectorMessage({
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
			connectedAt: this.stateSnapshot.persisted.connectedAt ?? now,
			lastSeenAt: now,
		}
		await this.persistState()
		ws.send(
			stringifyHomeConnectorMessage({
				type: 'server.ack',
				connectorId: canonicalInstanceId,
			}),
		)
		try {
			await this.refreshToolsSnapshot()
		} catch (error) {
			this.stateSnapshot.tools = []
			this.captureSessionMessage(
				'Home connector tools snapshot refresh failed after websocket hello.',
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
		const parsed = parseJsonRpcMessage(message)
		if ('result' in parsed || 'error' in parsed) {
			const pending = this.pendingRequests.get(String(parsed.id))
			if (!pending) return
			clearTimeout(pending.timeout)
			this.pendingRequests.delete(String(parsed.id))
			pending.resolve(parsed)
			return
		}
		if (
			'method' in parsed &&
			parsed.method === 'notifications/tools/list_changed'
		) {
			try {
				await this.refreshToolsSnapshot()
			} catch (error) {
				this.stateSnapshot.tools = []
				this.captureSessionMessage(
					'Home connector tools snapshot refresh failed.',
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
			tools?: Array<HomeConnectorSnapshot['tools'][number]>
		}
		this.stateSnapshot.tools = result.tools ?? []
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		await this.persistState()
	}

	private async sendRpcRequest(
		method: string,
		params: Record<string, unknown>,
	): Promise<HomeConnectorJsonRpcResponse> {
		const socket = this.ctx.getWebSockets(connectorTag)[0]
		if (!socket) {
			throw new Error('No home connector is currently connected.')
		}

		const id = crypto.randomUUID()
		const request = createJsonRpcRequest(id, method, params)

		const response = await new Promise<HomeConnectorJsonRpcResponse>(
			(resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pendingRequests.delete(id)
					reject(
						new Error(
							`Timed out waiting for home connector response to ${method}.`,
						),
					)
				}, rpcTimeoutMs)
				this.pendingRequests.set(id, {
					resolve,
					reject,
					timeout,
				})
				socket.send(
					stringifyHomeConnectorMessage({
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

export const HomeConnectorSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	HomeConnectorSessionBase,
)

export type HomeConnectorSession = InstanceType<typeof HomeConnectorSession>
