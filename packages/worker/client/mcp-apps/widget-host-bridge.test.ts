import { afterEach, expect, test } from 'bun:test'
import { createWidgetHostBridge } from './widget-host-bridge.ts'

type HostRequestMessage = {
	jsonrpc?: string
	id?: string | number | null
	method?: string
	params?: Record<string, unknown>
	type?: string
	payload?: Record<string, unknown>
}

const latestProtocolVersion = '2026-01-26'

const originalWindow = globalThis.window

afterEach(() => {
	if (originalWindow) {
		globalThis.window = originalWindow
		return
	}
	Reflect.deleteProperty(globalThis, 'window')
})

test('sendUserMessageWithFallback delivers ui/message to latest-protocol host', async () => {
	const deliveredChatMessages: Array<string> = []
	const hostPostedMessages: Array<HostRequestMessage> = []
	let bridge: ReturnType<typeof createWidgetHostBridge>
	let initialized = false

	const parentWindow = {
		postMessage(message: unknown) {
			if (!message || typeof message !== 'object' || Array.isArray(message)) {
				return
			}

			const request = message as HostRequestMessage
			hostPostedMessages.push(request)
			if (request.method === 'ui/initialize') {
				if (request.params?.protocolVersion !== latestProtocolVersion) {
					bridge.handleHostMessage({
						jsonrpc: '2.0',
						id: request.id,
						error: {
							code: -32602,
							message: `Unsupported protocol version ${String(
								request.params?.protocolVersion,
							)}`,
						},
					})
					return
				}

				initialized = true
				bridge.handleHostMessage({
					jsonrpc: '2.0',
					id: request.id,
					result: {
						protocolVersion: latestProtocolVersion,
						hostInfo: {
							name: 'mcp-jam-sim',
							version: '1.0.0',
						},
						hostCapabilities: {
							message: { text: {} },
						},
						hostContext: {},
					},
				})
				return
			}

			if (request.method !== 'ui/message') {
				return
			}

			const firstContent = Array.isArray(request.params?.content)
				? request.params.content[0]
				: null
			const text =
				firstContent &&
				typeof firstContent === 'object' &&
				(firstContent as { type?: unknown }).type === 'text' &&
				typeof (firstContent as { text?: unknown }).text === 'string'
					? (firstContent as { text: string }).text
					: null

			if (!initialized || request.params?.role !== 'user' || !text) {
				bridge.handleHostMessage({
					jsonrpc: '2.0',
					id: request.id,
					result: { isError: true },
				})
				return
			}

			deliveredChatMessages.push(text)
			bridge.handleHostMessage({
				jsonrpc: '2.0',
				id: request.id,
				result: {},
			})
		},
	}

	globalThis.window = {
		parent: parentWindow,
	} as unknown as Window & typeof globalThis

	bridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-shell',
			version: '1.0.0',
		},
		requestTimeoutMs: 500,
	})

	const messageText = 'Generated UI sent a follow-up message.'
	const sent = await bridge.sendUserMessageWithFallback(messageText)
	expect(sent).toBe(true)
	expect(deliveredChatMessages).toEqual([messageText])
	expect(hostPostedMessages.some((entry) => entry.type === 'prompt')).toBe(
		false,
	)
})

test('callTool proxies tools/call through the host bridge', async () => {
	const hostPostedMessages: Array<HostRequestMessage> = []
	let bridge: ReturnType<typeof createWidgetHostBridge>

	const parentWindow = {
		postMessage(message: unknown) {
			if (!message || typeof message !== 'object' || Array.isArray(message)) {
				return
			}

			const request = message as HostRequestMessage
			hostPostedMessages.push(request)
			if (request.method === 'ui/initialize') {
				bridge.handleHostMessage({
					jsonrpc: '2.0',
					id: request.id,
					result: {
						protocolVersion: latestProtocolVersion,
						hostInfo: {
							name: 'mcp-jam-sim',
							version: '1.0.0',
						},
						hostCapabilities: {
							message: { text: {} },
							serverTools: {},
						},
						hostContext: {},
					},
				})
				return
			}

			if (request.method !== 'tools/call') {
				return
			}

			bridge.handleHostMessage({
				jsonrpc: '2.0',
				id: request.id,
				result: {
					structuredContent: {
						appId: 'app-123',
						source: '<main>Hello</main>',
					},
				},
			})
		},
	}

	globalThis.window = {
		parent: parentWindow,
	} as unknown as Window & typeof globalThis

	bridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-shell',
			version: '1.0.0',
		},
		requestTimeoutMs: 500,
	})

	const result = await bridge.callTool({
		name: 'ui_load_app_source',
		arguments: {
			app_id: 'app-123',
		},
	})

	expect(result?.structuredContent).toEqual({
		appId: 'app-123',
		source: '<main>Hello</main>',
	})
	expect(
		hostPostedMessages.some(
			(entry) =>
				entry.method === 'tools/call' &&
				entry.params?.name === 'ui_load_app_source',
		),
	).toBe(true)
})

test('tool-result notification updates render data with structured content', async () => {
	const renderDataEvents: Array<Record<string, unknown> | undefined> = []

	globalThis.window = {
		parent: {
			postMessage() {
				// No-op for this notification-driven test.
			},
		},
	} as unknown as Window & typeof globalThis

	const bridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-shell',
			version: '1.0.0',
		},
		onRenderData(renderData) {
			renderDataEvents.push(renderData)
		},
	})

	bridge.handleHostMessage({
		type: 'ui-lifecycle-iframe-render-data',
		payload: {
			renderData: {
				theme: 'light',
				displayMode: 'inline',
			},
		},
	})

	bridge.handleHostMessage({
		jsonrpc: '2.0',
		method: 'ui/notifications/tool-result',
		params: {
			content: [
				{
					type: 'text',
					text: 'Generated UI ready',
				},
			],
			structuredContent: {
				renderSource: 'inline_code',
				runtime: 'html',
				sourceCode: '<main>Hello</main>',
			},
		},
	})

	expect(renderDataEvents.at(-1)).toEqual({
		theme: 'light',
		displayMode: 'inline',
		toolOutput: {
			renderSource: 'inline_code',
			runtime: 'html',
			sourceCode: '<main>Hello</main>',
		},
	})
})
