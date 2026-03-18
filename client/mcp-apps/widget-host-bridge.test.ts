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
			name: 'calculator-widget',
			version: '1.0.0',
		},
		requestTimeoutMs: 500,
	})

	const messageText = 'Calculator result: 7 + 3 = 10'
	const sent = await bridge.sendUserMessageWithFallback(messageText)
	expect(sent).toBe(true)
	expect(deliveredChatMessages).toEqual([messageText])
	expect(hostPostedMessages.some((entry) => entry.type === 'prompt')).toBe(
		false,
	)
})
