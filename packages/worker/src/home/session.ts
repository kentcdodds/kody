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

class HomeConnectorSessionBase extends DurableObject<Env> {
	private stateSnapshot: HomeConnectorSessionState = {
		persisted: {
			connectorId: null,
			connectedAt: null,
			lastSeenAt: null,
		},
		tools: [],
	}

	private pendingRequests = new Map<string, PendingRpcRequest>()

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		void this.restoreState()
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade(request)
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
		void this.handleWebSocketMessage(ws, message)
	}

	webSocketClose(_ws: WebSocket): void {
		this.stateSnapshot.persisted.lastSeenAt = new Date().toISOString()
		void this.persistState()
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
		const { connectorId, connectedAt, lastSeenAt } =
			this.stateSnapshot.persisted
		if (!connectorId || !connectedAt || !lastSeenAt) return null
		return {
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
		this.stateSnapshot = stored
	}

	private async persistState() {
		await this.ctx.storage.put(stateStorageKey, this.stateSnapshot)
	}

	private async handleWebSocketUpgrade(_request: Request) {
		const pair = new WebSocketPair()
		const sockets = Object.values(pair)
		const client = sockets[0]
		const server = sockets[1]
		if (!client || !server) {
			throw new Error('Failed to create WebSocket pair.')
		}
		this.ctx.acceptWebSocket(server, [connectorTag])
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
			ws.send(
				stringifyHomeConnectorMessage({
					type: 'server.error',
					message: error instanceof Error ? error.message : String(error),
				}),
			)
			return
		}

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
	}

	private async handleHello(ws: WebSocket, message: HomeConnectorHelloMessage) {
		const expectedSecret = this.env.HOME_CONNECTOR_SHARED_SECRET?.trim()
		if (!expectedSecret || message.sharedSecret !== expectedSecret) {
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
			connectorId: message.connectorId,
			connectedAt: this.stateSnapshot.persisted.connectedAt ?? now,
			lastSeenAt: now,
		}
		await this.persistState()
		ws.send(
			stringifyHomeConnectorMessage({
				type: 'server.ack',
				connectorId: message.connectorId,
			}),
		)
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
			await this.refreshToolsSnapshot()
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
}

export const HomeConnectorSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	HomeConnectorSessionBase,
)

export type HomeConnectorSession = InstanceType<typeof HomeConnectorSession>
