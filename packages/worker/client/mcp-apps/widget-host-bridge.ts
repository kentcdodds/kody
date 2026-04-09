/// <reference lib="dom" />
type WidgetHostBridgeOptions = {
	protocolVersion?: string
	requestTimeoutMs?: number
	appInfo?: {
		name: string
		version: string
	}
	onRenderData?: (renderData: Record<string, unknown> | undefined) => void
	onHostContextChanged?: (
		hostContext: Record<string, unknown> | undefined,
	) => void
}

type DisplayMode = 'inline' | 'fullscreen' | 'pip'
type SizeChangedInput = {
	height?: number
	width?: number
}

type ServerToolResult = {
	content?: Array<unknown>
	structuredContent?: unknown
	isError?: boolean
	_meta?: Record<string, unknown>
}

type WidgetHostBridge = {
	handleHostMessage(message: unknown): void
	initialize(): Promise<boolean>
	sendUserMessage(text: string): Promise<boolean>
	sendUserMessageWithFallback(text: string): Promise<boolean>
	sendSizeChanged(input: SizeChangedInput): Promise<boolean>
	requestRenderData(): boolean
	callTool(input: {
		name: string
		arguments?: Record<string, unknown>
		timeoutMs?: number
	}): Promise<ServerToolResult | null>
	openLink(url: string): Promise<boolean>
	requestDisplayMode(mode: DisplayMode): Promise<DisplayMode | null>
	updateModelContext(input: {
		content?: Array<Record<string, unknown>>
		structuredContent?: Record<string, unknown>
	}): Promise<boolean>
}

type BridgeResponseMessage = {
	jsonrpc: '2.0'
	id?: string | number | null
	result?: Record<string, unknown>
	error?: Record<string, unknown>
}

type PendingBridgeRequest = {
	resolve: (value: BridgeResponseMessage) => void
	reject: (reason?: unknown) => void
	timeoutId: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function toRequestId(value: string | number) {
	return String(value)
}

function getBridgeErrorMessage(error: unknown) {
	if (isRecord(error) && typeof error.message === 'string') {
		return error.message
	}
	return 'Bridge request failed'
}

function normalizeDimensionValue(value: unknown) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return undefined
	}
	return Math.round(value)
}

export function createWidgetHostBridge(
	options: WidgetHostBridgeOptions = {},
): WidgetHostBridge {
	const protocolVersion = options.protocolVersion ?? '2026-01-26'
	const requestTimeoutMs = options.requestTimeoutMs ?? 1500
	const appInfo = options.appInfo ?? {
		name: 'mcp-widget',
		version: '1.0.0',
	}
	const renderDataMessageType = 'ui-lifecycle-iframe-render-data'
	const hostContextChangedMethod = 'ui/notifications/host-context-changed'
	const toolInputMethod = 'ui/notifications/tool-input'
	const toolResultMethod = 'ui/notifications/tool-result'

	let requestCounter = 0
	let initialized = false
	let initializationPromise: Promise<boolean> | null = null
	const pendingRequests = new Map<string, PendingBridgeRequest>()
	let latestRenderData: Record<string, unknown> | undefined

	function postMessageToHost(message: Record<string, unknown>) {
		const hostWindow = globalThis.window?.parent
		if (!hostWindow) {
			throw new Error('Host window is unavailable')
		}
		hostWindow.postMessage(message, '*')
	}

	function dispatchRenderData(renderData: unknown) {
		if (!options.onRenderData) return
		const nextRenderData = isRecord(renderData) ? renderData : undefined
		latestRenderData = nextRenderData
		options.onRenderData(nextRenderData)
	}

	function dispatchHostContext(hostContext: unknown) {
		if (!options.onHostContextChanged) return
		options.onHostContextChanged(
			isRecord(hostContext) ? hostContext : undefined,
		)
	}

	function updateRenderData(patch: Record<string, unknown>) {
		const nextRenderData = normalizeRenderData({
			...(latestRenderData ?? {}),
			...patch,
		})
		dispatchRenderData(nextRenderData)
	}

	function normalizeToolOutput(value: unknown) {
		if (!isRecord(value)) return undefined
		if (isRecord(value.structuredContent)) {
			return value.structuredContent
		}
		if (isRecord(value.result)) {
			return value.result
		}
		return value
	}

	function normalizeRenderData(renderData: Record<string, unknown>) {
		const normalizedToolOutput = normalizeToolOutput(renderData.toolOutput)
		return normalizedToolOutput
			? {
					...renderData,
					toolOutput: normalizedToolOutput,
				}
			: renderData
	}

	function normalizeToolNotificationPayload(
		params: unknown,
		key: 'toolInput' | 'toolOutput',
	) {
		if (!isRecord(params)) return
		if (key === 'toolOutput') {
			const normalizedToolOutput = normalizeToolOutput(params)
			if (normalizedToolOutput) {
				updateRenderData({ toolOutput: normalizedToolOutput })
				return
			}
		}
		const nestedKey = key === 'toolInput' ? 'input' : 'result'
		const nestedValue = params[nestedKey]
		if (isRecord(nestedValue)) {
			updateRenderData({ [key]: nestedValue })
			return
		}
		updateRenderData({ [key]: params })
	}

	function handleBridgeResponseMessage(message: unknown) {
		if (!isRecord(message)) return
		if (message.jsonrpc !== '2.0') return
		if (typeof message.id !== 'string' && typeof message.id !== 'number') return

		const requestId = toRequestId(message.id)
		const pendingRequest = pendingRequests.get(requestId)
		if (!pendingRequest) return

		globalThis.clearTimeout(pendingRequest.timeoutId)
		pendingRequests.delete(requestId)

		const response: BridgeResponseMessage = {
			jsonrpc: '2.0',
			id: message.id,
			result: isRecord(message.result) ? message.result : undefined,
			error: isRecord(message.error) ? message.error : undefined,
		}

		if (response.error) {
			pendingRequest.reject(new Error(getBridgeErrorMessage(response.error)))
			return
		}

		pendingRequest.resolve(response)
	}

	function handleLifecycleMessage(message: unknown) {
		if (!isRecord(message)) return

		if (message.type === renderDataMessageType) {
			const payload = isRecord(message.payload) ? message.payload : undefined
			if (isRecord(payload?.renderData)) {
				updateRenderData(payload.renderData)
				return
			}
			dispatchRenderData(payload?.renderData)
			return
		}

		if (message.method === hostContextChangedMethod) {
			dispatchHostContext(message.params)
			if (isRecord(message.params)) {
				updateRenderData(message.params)
			}
			return
		}

		if (message.method === toolInputMethod) {
			normalizeToolNotificationPayload(message.params, 'toolInput')
			return
		}

		if (message.method === toolResultMethod) {
			normalizeToolNotificationPayload(message.params, 'toolOutput')
		}
	}

	function handleHostMessage(message: unknown) {
		handleBridgeResponseMessage(message)
		handleLifecycleMessage(message)
	}

	function sendBridgeRequest(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = requestTimeoutMs,
	): Promise<BridgeResponseMessage> {
		return new Promise<BridgeResponseMessage>((resolve, reject) => {
			requestCounter += 1
			const requestId = toRequestId(`${appInfo.name}-bridge-${requestCounter}`)
			const timeoutId = globalThis.setTimeout(() => {
				pendingRequests.delete(requestId)
				reject(new Error('Bridge request timed out'))
			}, timeoutMs)

			pendingRequests.set(requestId, {
				resolve,
				reject,
				timeoutId,
			})

			try {
				postMessageToHost({
					jsonrpc: '2.0',
					id: requestId,
					method,
					params,
				})
			} catch (error) {
				pendingRequests.delete(requestId)
				globalThis.clearTimeout(timeoutId)
				reject(error)
			}
		})
	}

	async function initialize() {
		if (initialized) return true
		if (initializationPromise) return initializationPromise

		initializationPromise = sendBridgeRequest('ui/initialize', {
			appInfo,
			appCapabilities: {},
			protocolVersion,
		})
			.then((response) => {
				const hostContext = response.result?.hostContext
				dispatchHostContext(hostContext)
				if (isRecord(hostContext)) {
					updateRenderData(hostContext)
				}
				initialized = true
				try {
					postMessageToHost({
						jsonrpc: '2.0',
						method: 'ui/notifications/initialized',
						params: {},
					})
				} catch {
					// Ignore initialized notification failures and continue.
				}
				return true
			})
			.catch(() => {
				return false
			})
			.finally(() => {
				initializationPromise = null
			})

		return initializationPromise
	}

	async function sendUserMessage(text: string) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return false

		try {
			const response = await sendBridgeRequest('ui/message', {
				role: 'user',
				content: [{ type: 'text', text }],
			})
			return response.result?.isError !== true
		} catch {
			return false
		}
	}

	async function sendUserMessageWithFallback(text: string) {
		const bridgeSent = await sendUserMessage(text)
		if (bridgeSent) return true

		try {
			postMessageToHost({
				type: 'prompt',
				payload: { prompt: text },
			})
			return true
		} catch {
			return false
		}
	}

	async function sendSizeChanged(input: SizeChangedInput) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return false

		const height = normalizeDimensionValue(input.height)
		const width = normalizeDimensionValue(input.width)
		if (height == null && width == null) {
			return false
		}

		try {
			postMessageToHost({
				jsonrpc: '2.0',
				method: 'ui/notifications/size-changed',
				params: {
					...(height == null ? {} : { height }),
					...(width == null ? {} : { width }),
				},
			})
			return true
		} catch {
			return false
		}
	}

	async function callTool(input: {
		name: string
		arguments?: Record<string, unknown>
		timeoutMs?: number
	}) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return null

		try {
			const response = await sendBridgeRequest(
				'tools/call',
				{
					name: input.name,
					...(input.arguments ? { arguments: input.arguments } : {}),
				},
				input.timeoutMs,
			)
			const result = response.result
			if (!result) return null
			return {
				content: Array.isArray(result.content) ? result.content : undefined,
				structuredContent: result.structuredContent,
				isError: result.isError === true,
				_meta: isRecord(result._meta) ? result._meta : undefined,
			}
		} catch {
			return null
		}
	}

	async function openLink(url: string) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return false

		try {
			const response = await sendBridgeRequest('ui/open-link', { url })
			return response.result?.isError !== true
		} catch {
			return false
		}
	}

	async function requestDisplayMode(mode: DisplayMode) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return null

		try {
			const response = await sendBridgeRequest('ui/request-display-mode', {
				mode,
			})
			const nextMode = response.result?.mode
			return nextMode === 'inline' ||
				nextMode === 'fullscreen' ||
				nextMode === 'pip'
				? nextMode
				: null
		} catch {
			return null
		}
	}

	async function updateModelContext(input: {
		content?: Array<Record<string, unknown>>
		structuredContent?: Record<string, unknown>
	}) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return false

		try {
			const response = await sendBridgeRequest('ui/update-model-context', {
				...(input.content ? { content: input.content } : {}),
				...(input.structuredContent
					? { structuredContent: input.structuredContent }
					: {}),
			})
			return response.error == null
		} catch {
			return false
		}
	}

	function requestRenderData() {
		try {
			postMessageToHost({
				type: 'ui-request-render-data',
				payload: {},
			})
			return true
		} catch {
			return false
		}
	}

	return {
		handleHostMessage,
		initialize,
		sendUserMessage,
		sendUserMessageWithFallback,
		sendSizeChanged,
		requestRenderData,
		callTool,
		openLink,
		requestDisplayMode,
		updateModelContext,
	}
}
