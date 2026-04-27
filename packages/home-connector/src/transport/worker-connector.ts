import {
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js'
import {
	type HomeConnectorAckMessage,
	type HomeConnectorHelloMessage,
	type HomeConnectorClientMessage,
	type HomeConnectorJsonRpcEnvelope,
} from '../../../worker/src/home/types.ts'
import { stringifyHomeConnectorMessage } from '../../../worker/src/home/utils.ts'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorState, updateConnectionState } from '../state.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'
import {
	addHomeConnectorSentryBreadcrumb,
	captureHomeConnectorException,
	captureHomeConnectorMessage,
} from '../sentry.ts'

const heartbeatIntervalMs = 10_000
const initialReconnectDelayMs = 2_000
const maxReconnectDelayMs = 30_000
const slowToolCallThresholdMs = 5_000

function isJsonRpcResponse(
	message: JSONRPCMessage,
): message is JSONRPCResponse {
	return 'id' in message && ('result' in message || 'error' in message)
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
	return 'id' in message && 'method' in message
}

function isAckMessage(
	message: HomeConnectorClientMessage,
): message is HomeConnectorAckMessage {
	return message.type === 'server.ack'
}

function isJsonRpcEnvelope(
	message: HomeConnectorClientMessage | HomeConnectorJsonRpcEnvelope,
): message is HomeConnectorJsonRpcEnvelope {
	return message.type === 'connector.jsonrpc'
}

function createToolsChangedNotification(): JSONRPCMessage {
	return {
		jsonrpc: '2.0',
		method: 'notifications/tools/list_changed',
	}
}

function formatRequestId(id: JSONRPCRequest['id']) {
	if (typeof id === 'string' || typeof id === 'number') {
		return String(id)
	}
	return JSON.stringify(id)
}

function formatCloseMessage(event: CloseEvent) {
	const reason = event.reason ? ` reason=${event.reason}` : ''
	return `Home connector websocket closed code=${event.code} wasClean=${event.wasClean}${reason}`
}

function getReconnectDelayMs(consecutiveReconnects: number) {
	const backoffMultiplier = 2 ** Math.max(0, consecutiveReconnects - 1)
	return Math.min(
		initialReconnectDelayMs * backoffMultiplier,
		maxReconnectDelayMs,
	)
}

function createSocketEventContext(input: {
	config: HomeConnectorConfig
	connectionAttempt: number
	consecutiveReconnects: number
}) {
	return {
		attempt: input.connectionAttempt,
		consecutiveReconnects: input.consecutiveReconnects,
		connectorId: input.config.homeConnectorId,
		url: input.config.workerWebSocketUrl,
	}
}

function createSocketPayloadPreview(data: unknown) {
	const raw = String(data)
	const maxPreviewLength = 500
	if (raw.length <= maxPreviewLength) {
		return {
			rawMessagePreview: raw,
			rawMessageLength: raw.length,
		}
	}
	return {
		rawMessagePreview: `${raw.slice(0, maxPreviewLength)}...[truncated]`,
		rawMessageLength: raw.length,
	}
}

async function handleJsonRpcRequest(
	message: JSONRPCRequest,
	toolRegistry: HomeConnectorToolRegistry,
) {
	if (message.method === 'tools/list') {
		return {
			jsonrpc: '2.0',
			id: message.id,
			result: {
				tools: toolRegistry.list(),
			},
		} satisfies JSONRPCResponse
	}

	if (message.method === 'tools/call') {
		const params = (message.params ?? {}) as {
			name?: string
			arguments?: Record<string, unknown>
		}
		const name = params.name?.trim()
		if (!name) {
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32602,
					message: 'Missing tool name.',
				},
			} satisfies JSONRPCResponse
		}

		const startedAt = Date.now()
		const requestId = formatRequestId(message.id)
		const argumentKeys = Object.keys(params.arguments ?? {})
		console.info(
			`Home connector tool call started: ${name} requestId=${requestId} argKeys=${argumentKeys.join(',') || 'none'}`,
		)

		try {
			const result = await toolRegistry.call(name, params.arguments ?? {}, {
				requestId,
				transport: 'websocket',
				source: 'worker-connector',
			})
			const durationMs = Date.now() - startedAt
			console.info(
				`Home connector tool call finished: ${name} requestId=${requestId} durationMs=${durationMs}`,
			)
			if (durationMs >= slowToolCallThresholdMs) {
				captureHomeConnectorMessage('Home connector tool call was slow.', {
					level: 'warning',
					tags: {
						connector_event: 'tool_call.slow',
						connector_tool_name: name,
					},
					extra: {
						durationMs,
						requestId,
						argumentKeys,
					},
				})
			}
			return {
				jsonrpc: '2.0',
				id: message.id,
				result,
			} satisfies JSONRPCResponse
		} catch (error: unknown) {
			const durationMs = Date.now() - startedAt
			console.error(
				`Home connector tool call failed: ${name} requestId=${requestId} durationMs=${durationMs}`,
				error,
			)
			captureHomeConnectorException(error, {
				tags: {
					connector_tool_name: name,
				},
				contexts: {
					mcp_request: {
						method: message.method,
						requestId,
						durationMs,
						argumentKeys,
					},
				},
			})
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : String(error),
				},
			} satisfies JSONRPCResponse
		}
	}

	return {
		jsonrpc: '2.0',
		id: message.id,
		error: {
			code: -32601,
			message: `Connector request handling is not implemented for ${message.method}.`,
		},
	} satisfies JSONRPCResponse
}

export function createWorkerConnector(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	toolRegistry: HomeConnectorToolRegistry
}) {
	let started = false
	let stopped = false
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let socket: WebSocket | null = null
	let hasReportedSocketIssue = false
	let connectionAttempt = 0
	let consecutiveReconnects = 0

	const heartbeat = setInterval(() => {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(
				stringifyHomeConnectorMessage({
					type: 'connector.heartbeat',
				}),
			)
		}
	}, heartbeatIntervalMs)

	function clearReconnectTimer() {
		if (!reconnectTimer) return
		clearTimeout(reconnectTimer)
		reconnectTimer = null
	}

	function scheduleReconnect() {
		if (stopped || reconnectTimer) return
		consecutiveReconnects += 1
		const reconnectDelayMs = getReconnectDelayMs(consecutiveReconnects)
		console.info(
			`Scheduling home connector websocket reconnect in ${reconnectDelayMs}ms consecutiveReconnects=${consecutiveReconnects}`,
		)
		addHomeConnectorSentryBreadcrumb(
			'Scheduling home connector websocket reconnect.',
			{
				level: 'info',
				tags: {
					connector_event: 'websocket.reconnect_scheduled',
				},
				extra: {
					...createSocketEventContext({
						config: input.config,
						connectionAttempt,
						consecutiveReconnects,
					}),
					reconnectDelayMs,
				},
			},
		)
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null
			connect()
		}, reconnectDelayMs)
	}

	function connect() {
		if (stopped || !input.config.sharedSecret) {
			return
		}
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			return
		}
		clearReconnectTimer()
		connectionAttempt += 1
		updateConnectionState(input.state, {
			connected: false,
			lastError: null,
		})
		console.info(
			`Opening home connector websocket attempt=${connectionAttempt} url=${input.config.workerWebSocketUrl}`,
		)
		addHomeConnectorSentryBreadcrumb('Opening home connector websocket.', {
			level: 'info',
			tags: {
				connector_event: 'websocket.connecting',
			},
			extra: createSocketEventContext({
				config: input.config,
				connectionAttempt,
				consecutiveReconnects,
			}),
		})
		socket = new WebSocket(input.config.workerWebSocketUrl)

		socket.addEventListener('open', () => {
			console.info(
				`Home connector websocket opened attempt=${connectionAttempt} connectorId=${input.config.homeConnectorId}`,
			)
			addHomeConnectorSentryBreadcrumb('Home connector websocket opened.', {
				level: 'info',
				tags: {
					connector_event: 'websocket.open',
				},
				extra: createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
			})
			const hello: HomeConnectorHelloMessage = {
				type: 'connector.hello',
				connectorKind: 'home',
				connectorId: input.config.homeConnectorId,
				sharedSecret: input.config.sharedSecret!,
			}
			addHomeConnectorSentryBreadcrumb('Sending home connector websocket hello.', {
				level: 'info',
				tags: {
					connector_event: 'websocket.hello_sent',
				},
				extra: createSocketEventContext({
					config: input.config,
					connectionAttempt,
					consecutiveReconnects,
				}),
			})
			socket?.send(stringifyHomeConnectorMessage(hello))
		})

		socket.addEventListener('message', async (event) => {
			try {
				const value = JSON.parse(String(event.data)) as
					| HomeConnectorClientMessage
					| HomeConnectorJsonRpcEnvelope
				switch (value.type) {
					case 'server.ping':
						hasReportedSocketIssue = false
						updateConnectionState(input.state, {
							lastSyncAt: new Date().toISOString(),
							lastError: null,
						})
						return
					case 'server.error':
						updateConnectionState(input.state, {
							connected: false,
							lastError: value.message,
						})
						captureHomeConnectorMessage(value.message, {
							level: 'error',
							tags: {
								connector_event: 'server.error',
							},
							extra: createSocketEventContext({
								config: input.config,
								connectionAttempt,
								consecutiveReconnects,
							}),
						})
						console.error(`Home connector error: ${value.message}`)
						return
					case 'server.ack':
						hasReportedSocketIssue = false
						const previousConsecutiveReconnects = consecutiveReconnects
						updateConnectionState(input.state, {
							connected: true,
							lastSyncAt: new Date().toISOString(),
							lastError: null,
						})
						console.info(
							`Home connector websocket acknowledged connectorId=${value.connectorId}`,
						)
						addHomeConnectorSentryBreadcrumb(
							'Home connector websocket acknowledged.',
							{
								level: 'info',
								tags: {
									connector_event: 'websocket.ack',
								},
								extra: {
									...createSocketEventContext({
										config: input.config,
										connectionAttempt,
										consecutiveReconnects:
											previousConsecutiveReconnects,
									}),
									acknowledgedConnectorId: value.connectorId,
								},
							},
						)
						if (socket?.readyState === WebSocket.OPEN) {
							addHomeConnectorSentryBreadcrumb(
								'Sending home connector tools changed notification.',
								{
									level: 'info',
									tags: {
										connector_event: 'tools.list_changed.sent',
									},
									extra: createSocketEventContext({
										config: input.config,
										connectionAttempt,
										consecutiveReconnects:
											previousConsecutiveReconnects,
									}),
								},
							)
							socket.send(
								stringifyHomeConnectorMessage({
									type: 'connector.jsonrpc',
									message: createToolsChangedNotification(),
								}),
							)
						}
						consecutiveReconnects = 0
						return
					case 'connector.jsonrpc': {
						const message = value.message
						if (isJsonRpcResponse(message)) {
							updateConnectionState(input.state, {
								lastSyncAt: new Date().toISOString(),
								lastError: null,
							})
							return
						}
						if (
							isJsonRpcRequest(message) &&
							socket?.readyState === WebSocket.OPEN
						) {
							const response = await handleJsonRpcRequest(
								message,
								input.toolRegistry,
							)
							socket.send(
								stringifyHomeConnectorMessage({
									type: 'connector.jsonrpc',
									message: response,
								}),
							)
							updateConnectionState(input.state, {
								lastSyncAt: new Date().toISOString(),
								lastError: null,
							})
						}
						return
					}
				}
			} catch (error) {
				updateConnectionState(input.state, {
					lastError:
						error instanceof Error
							? error.message
							: 'Home connector websocket message handling failed.',
				})
				captureHomeConnectorException(error, {
					tags: {
						connector_event: 'websocket.message_error',
					},
					contexts: {
						websocket: {
							...createSocketEventContext({
								config: input.config,
								connectionAttempt,
								consecutiveReconnects,
							}),
							readyState: socket?.readyState ?? null,
						},
					},
					extra: {
						...createSocketPayloadPreview(event.data),
					},
				})
				console.error(
					'Home connector websocket message handling failed',
					error,
				)
			}
		})

		socket.addEventListener('close', (event) => {
			const closeMessage = formatCloseMessage(event)
			updateConnectionState(input.state, {
				connected: false,
				lastError: closeMessage,
			})
			if (!hasReportedSocketIssue) {
				hasReportedSocketIssue = true
				captureHomeConnectorMessage(closeMessage, {
					level: 'warning',
					tags: {
						connector_event: 'websocket.close',
					},
					extra: {
						code: event.code,
						reason: event.reason,
						wasClean: event.wasClean,
						attempt: connectionAttempt,
					},
				})
			}
			console.warn(closeMessage)
			socket = null
			scheduleReconnect()
		})

		socket.addEventListener('error', (event) => {
			updateConnectionState(input.state, {
				connected: false,
				lastError: 'Home connector websocket error.',
			})
			if (!hasReportedSocketIssue) {
				hasReportedSocketIssue = true
				captureHomeConnectorMessage('Home connector websocket error.', {
					level: 'error',
					tags: {
						connector_event: 'websocket.error',
					},
					extra: {
						eventType: event.type,
						readyState: socket?.readyState,
						url: input.config.workerWebSocketUrl,
						attempt: connectionAttempt,
					},
				})
			}
			console.error('Home connector websocket error', {
				eventType: event.type,
				readyState: socket?.readyState,
				url: input.config.workerWebSocketUrl,
				attempt: connectionAttempt,
			})
		})
	}

	return {
		async start() {
			if (started) return
			started = true
			if (!input.config.sharedSecret) {
				updateConnectionState(input.state, {
					connected: false,
					lastError:
						'Connector registration is disabled because HOME_CONNECTOR_SHARED_SECRET is not set. Start from the repo root with `npm run dev` or provide the secret manually.',
				})
				return
			}
			connect()
		},
		stop() {
			stopped = true
			clearReconnectTimer()
			clearInterval(heartbeat)
			socket?.close()
			socket = null
		},
	}
}
