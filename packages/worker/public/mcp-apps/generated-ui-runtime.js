/* eslint-disable no-undef */

// packages/worker/client/mcp-apps/widget-host-bridge.ts
function isRecord(value) {
	return typeof value === 'object' && value !== null
}
function toRequestId(value) {
	return String(value)
}
function getBridgeErrorMessage(error) {
	if (isRecord(error) && typeof error.message === 'string') {
		return error.message
	}
	return 'Bridge request failed'
}
function normalizeDimensionValue(value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return void 0
	}
	return Math.round(value)
}
function createWidgetHostBridge(options = {}) {
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
	let initializationPromise = null
	const pendingRequests = /* @__PURE__ */ new Map()
	let latestRenderData
	function postMessageToHost(message) {
		const hostWindow = globalThis.window?.parent
		if (!hostWindow) {
			throw new Error('Host window is unavailable')
		}
		hostWindow.postMessage(message, '*')
	}
	function dispatchRenderData(renderData) {
		if (!options.onRenderData) return
		const nextRenderData = isRecord(renderData) ? renderData : void 0
		latestRenderData = nextRenderData
		options.onRenderData(nextRenderData)
	}
	function dispatchHostContext(hostContext) {
		if (!options.onHostContextChanged) return
		options.onHostContextChanged(isRecord(hostContext) ? hostContext : void 0)
	}
	function updateRenderData(patch) {
		const nextRenderData = {
			...(latestRenderData ?? {}),
			...patch,
		}
		dispatchRenderData(nextRenderData)
	}
	function normalizeToolNotificationPayload(params, key) {
		if (!isRecord(params)) return
		if (key === 'toolOutput') {
			const structuredContent = params.structuredContent
			if (isRecord(structuredContent)) {
				updateRenderData({ toolOutput: structuredContent })
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
	function handleBridgeResponseMessage(message) {
		if (!isRecord(message)) return
		if (message.jsonrpc !== '2.0') return
		if (typeof message.id !== 'string' && typeof message.id !== 'number') return
		const requestId = toRequestId(message.id)
		const pendingRequest = pendingRequests.get(requestId)
		if (!pendingRequest) return
		globalThis.clearTimeout(pendingRequest.timeoutId)
		pendingRequests.delete(requestId)
		const response = {
			jsonrpc: '2.0',
			id: message.id,
			result: isRecord(message.result) ? message.result : void 0,
			error: isRecord(message.error) ? message.error : void 0,
		}
		if (response.error) {
			pendingRequest.reject(new Error(getBridgeErrorMessage(response.error)))
			return
		}
		pendingRequest.resolve(response)
	}
	function handleLifecycleMessage(message) {
		if (!isRecord(message)) return
		if (message.type === renderDataMessageType) {
			const payload = isRecord(message.payload) ? message.payload : void 0
			const renderData = isRecord(payload?.renderData)
				? {
						...(latestRenderData ?? {}),
						...payload.renderData,
					}
				: payload?.renderData
			dispatchRenderData(renderData)
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
	function handleHostMessage(message) {
		handleBridgeResponseMessage(message)
		handleLifecycleMessage(message)
	}
	function sendBridgeRequest(method, params, timeoutMs = requestTimeoutMs) {
		return new Promise((resolve, reject) => {
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
				} catch {}
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
	async function sendUserMessage(text) {
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
	async function sendUserMessageWithFallback(text) {
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
	async function sendSizeChanged(input) {
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
	async function callTool(input) {
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
				content: Array.isArray(result.content) ? result.content : void 0,
				structuredContent: result.structuredContent,
				isError: result.isError === true,
				_meta: isRecord(result._meta) ? result._meta : void 0,
			}
		} catch {
			return null
		}
	}
	async function openLink(url) {
		const bridgeReady = await initialize()
		if (!bridgeReady) return false
		try {
			const response = await sendBridgeRequest('ui/open-link', { url })
			return response.result?.isError !== true
		} catch {
			return false
		}
	}
	async function requestDisplayMode(mode) {
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
	async function updateModelContext(input) {
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

// packages/worker/client/mcp-apps/generated-ui-widget-runtime.ts
var kodyWindow = typeof window === 'object' && window ? window : globalThis
function isRecord2(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function coerceStorageScope(value) {
	return value === 'session' || value === 'app' || value === 'user'
		? value
		: null
}
function coerceValueMetadata(value) {
	if (!isRecord2(value)) return null
	const record = value
	const scope = coerceStorageScope(record.scope)
	if (
		typeof record.name !== 'string' ||
		typeof record.value !== 'string' ||
		typeof record.description !== 'string' ||
		scope == null ||
		(record.app_id != null && typeof record.app_id !== 'string') ||
		typeof record.created_at !== 'string' ||
		typeof record.updated_at !== 'string' ||
		(record.ttl_ms != null &&
			(typeof record.ttl_ms !== 'number' ||
				!Number.isFinite(record.ttl_ms) ||
				record.ttl_ms < 0))
	) {
		return null
	}
	return {
		name: record.name,
		scope,
		value: record.value,
		description: record.description,
		app_id: record.app_id ?? null,
		created_at: record.created_at,
		updated_at: record.updated_at,
		ttl_ms: record.ttl_ms ?? null,
	}
}
function coerceSecretMetadata(value) {
	if (!isRecord2(value)) return null
	const record = value
	const scope = coerceStorageScope(record.scope)
	if (
		typeof record.name !== 'string' ||
		typeof record.description !== 'string' ||
		scope == null ||
		(record.app_id != null && typeof record.app_id !== 'string') ||
		!Array.isArray(record.allowed_hosts) ||
		!record.allowed_hosts.every((host) => typeof host === 'string') ||
		typeof record.created_at !== 'string' ||
		typeof record.updated_at !== 'string' ||
		(record.ttl_ms != null &&
			(typeof record.ttl_ms !== 'number' ||
				!Number.isFinite(record.ttl_ms) ||
				record.ttl_ms < 0))
	) {
		return null
	}
	return {
		name: record.name,
		scope,
		description: record.description,
		app_id: record.app_id ?? null,
		allowed_hosts: record.allowed_hosts,
		created_at: record.created_at,
		updated_at: record.updated_at,
		ttl_ms: record.ttl_ms ?? null,
	}
}
function buildCodemodeCapabilityExecuteCode(name, args = {}) {
	return [
		'async () => {',
		'  return await codemode[' +
			JSON.stringify(name) +
			'](' +
			JSON.stringify(args ?? {}) +
			');',
		'}',
	].join('\n')
}
function normalizeSecretNameList(values) {
	return Array.from(
		new Set(
			values.filter((value) => typeof value === 'string' && value.length > 0),
		),
	)
}
function extractSecretNamesFromValue(value, collected = []) {
	if (typeof value === 'string') {
		for (const match of value.matchAll(/\{\{secret:([a-zA-Z0-9._-]+)/g)) {
			if (match[1]) collected.push(match[1])
		}
		return collected
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			extractSecretNamesFromValue(entry, collected)
		}
		return collected
	}
	if (isRecord2(value)) {
		for (const entry of Object.values(value)) {
			extractSecretNamesFromValue(entry, collected)
		}
	}
	return collected
}
function extractApprovalDetails(message, fallbackSecretNames = []) {
	const text = typeof message === 'string' ? message : String(message ?? '')
	const secretNames = normalizeSecretNameList([
		...Array.from(text.matchAll(/Secret "([^"]+)"/g))
			.map((match) => match[1])
			.filter(Boolean),
		...fallbackSecretNames,
	])
	const hostMatch = text.match(/host "([^"]+)"/)
	let approvalUrl = null
	for (const part of text.split(/\s+/)) {
		if (part.startsWith('http://') || part.startsWith('https://')) {
			approvalUrl = part.replace(/[),.;]+$/, '')
			break
		}
	}
	return {
		message: text,
		approvalUrl,
		host: hostMatch?.[1] ?? null,
		secretNames,
	}
}
function resolveFormReference(formRef) {
	if (typeof formRef === 'string') {
		return document.querySelector(formRef)
	}
	return formRef && typeof formRef === 'object' ? formRef : null
}
function formDataToObject(formData) {
	const result = {}
	for (const name of new Set(formData.keys())) {
		const all = formData
			.getAll(name)
			.map((entry) => (typeof entry === 'string' ? entry : entry.name))
		result[name] = all.length > 1 ? all : (all[0] ?? null)
	}
	return result
}
function pickLastFormValue(value) {
	if (Array.isArray(value)) {
		const lastValue = value.length > 0 ? value[value.length - 1] : null
		return typeof lastValue === 'string'
			? lastValue
			: lastValue == null
				? null
				: String(lastValue)
	}
	return typeof value === 'string'
		? value
		: value == null
			? null
			: String(value)
}
function toStringArray(value) {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			typeof entry === 'string' ? entry : String(entry),
		)
	}
	if (value == null) return []
	return [typeof value === 'string' ? value : String(value)]
}
function setControlValues(form, name, values) {
	const controls = Array.from(form.elements).filter((element) => {
		return (
			element &&
			typeof element === 'object' &&
			'name' in element &&
			element.name === name
		)
	})
	if (controls.length === 0) return
	for (const control of controls) {
		if (control instanceof HTMLInputElement) {
			if (control.type !== 'checkbox' && control.type !== 'radio') {
				control.value =
					values.length > 0 ? (values[values.length - 1] ?? '') : ''
				continue
			}
			const controlValue =
				typeof control.value === 'string' && control.value.length > 0
					? control.value
					: 'on'
			control.checked =
				values.includes(controlValue) ||
				(control.type === 'checkbox' &&
					controlValue === 'on' &&
					values.some(
						(value) => value === 'true' || value === '1' || value === 'on',
					))
			continue
		}
		if (control instanceof HTMLSelectElement && control.multiple) {
			for (const option of Array.from(control.options)) {
				option.selected = values.includes(option.value)
			}
			continue
		}
		if (
			control instanceof HTMLSelectElement ||
			control instanceof HTMLTextAreaElement
		) {
			control.value = values.length > 0 ? (values[values.length - 1] ?? '') : ''
		}
	}
}
function getTopLocationUrl(inputUrl) {
	if (inputUrl) {
		return new URL(inputUrl, window.location.href)
	}
	try {
		if (window.top && window.top.location && window.top.location.href) {
			return new URL(window.top.location.href)
		}
	} catch {}
	return new URL(window.location.href)
}
function normalizeFetchWithSecretsInput(input) {
	if (!isRecord2(input)) {
		return { ok: false, error: 'fetchWithSecrets input must be an object.' }
	}
	if (typeof input.url !== 'string' || input.url.length === 0) {
		return { ok: false, error: 'fetchWithSecrets requires a url.' }
	}
	const headers = {}
	if (isRecord2(input.headers)) {
		for (const [key, value] of Object.entries(input.headers)) {
			if (typeof value === 'string') {
				headers[key] = value
			}
		}
	}
	let body = input.body
	if (body != null && typeof body !== 'string') {
		body = JSON.stringify(body)
		const hasContentType = Object.keys(headers).some(
			(key) => key.toLowerCase() === 'content-type',
		)
		if (!hasContentType) {
			headers['Content-Type'] = 'application/json'
		}
	}
	return {
		ok: true,
		value: {
			url: input.url,
			method:
				typeof input.method === 'string' && input.method.length > 0
					? input.method.toUpperCase()
					: 'GET',
			headers,
			body: typeof body === 'string' ? body : void 0,
		},
	}
}
function buildFetchWithSecretsExecuteCode(input) {
	return [
		'async () => {',
		'  const response = await fetch(' + JSON.stringify(input.url) + ', {',
		'    method: ' + JSON.stringify(input.method) + ',',
		'    headers: ' + JSON.stringify(input.headers) + ',',
		input.body != null ? '    body: ' + JSON.stringify(input.body) + ',' : '',
		'  });',
		'  const headers = Object.fromEntries(response.headers.entries());',
		'  const contentType = response.headers.get("content-type") || "";',
		'  const text = await response.text();',
		'  let data = null;',
		'  if (/\\bjson\\b/i.test(contentType) && text) {',
		'    try {',
		'      data = JSON.parse(text);',
		'    } catch {}',
		'  }',
		'  return {',
		'    ok: response.ok,',
		'    status: response.status,',
		'    headers,',
		'    data,',
		'    text: text || null,',
		'  };',
		'}',
	]
		.filter(Boolean)
		.join('\n')
}
function normalizeFetchWithSecretsResult(result) {
	if (!isRecord2(result)) {
		return {
			ok: false,
			kind: 'execution_error',
			message: 'fetchWithSecrets returned an invalid result.',
		}
	}
	const headers = isRecord2(result.headers)
		? Object.fromEntries(
				Object.entries(result.headers).filter(
					(entry) => typeof entry[1] === 'string',
				),
			)
		: {}
	const status = typeof result.status === 'number' ? result.status : 0
	const text =
		typeof result.text === 'string' || result.text == null ? result.text : null
	const data = 'data' in result ? result.data : null
	if (result.ok === true) {
		return {
			ok: true,
			status,
			headers,
			data,
			text,
		}
	}
	return {
		ok: false,
		kind: 'http_error',
		status,
		headers,
		data,
		text,
	}
}
function appendOAuthExtraParams(params, extraParams) {
	if (!isRecord2(extraParams)) return
	for (const [key, value] of Object.entries(extraParams)) {
		if (value == null) continue
		params.set(key, typeof value === 'string' ? value : String(value))
	}
}
async function readOAuthFetchResult(response) {
	const headers = Object.fromEntries(response.headers.entries())
	const contentType = response.headers.get('content-type') || ''
	const text = await response.text()
	let data = null
	if (/\bjson\b/i.test(contentType) && text) {
		try {
			data = JSON.parse(text)
		} catch {}
	}
	return {
		ok: response.ok,
		status: response.status,
		headers,
		data,
		text: text || null,
	}
}
function ensureLocalMessageLog() {
	const doc = window.document
	if (!doc || typeof doc.createElement !== 'function') return null
	const host = doc.body || doc.documentElement
	if (!host) return null
	const existingRoot = kodyWindow.__kodyLocalMessageLogRoot
	const existingList = kodyWindow.__kodyLocalMessageLogList
	if (existingRoot && existingList && existingRoot.parentNode) {
		return { root: existingRoot, list: existingList }
	}
	const root = doc.createElement('section')
	root.setAttribute('data-kody-local-message-log', 'true')
	root.setAttribute('role', 'log')
	root.setAttribute('aria-live', 'polite')
	root.style.cssText = [
		'position:fixed',
		'left:12px',
		'right:12px',
		'bottom:calc(env(safe-area-inset-bottom, 0px) + 12px)',
		'z-index:2147483647',
		'display:flex',
		'flex-direction:column',
		'gap:8px',
		'max-height:min(40vh, 320px)',
		'padding:12px',
		'overflow:auto',
		'border-radius:16px',
		'background:rgba(15, 23, 42, 0.92)',
		'color:#f8fafc',
		'box-shadow:0 16px 40px rgba(15, 23, 42, 0.28)',
		'font:500 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
		'box-sizing:border-box',
		'backdrop-filter:blur(16px)',
		'-webkit-backdrop-filter:blur(16px)',
	].join(';')
	const title = doc.createElement('div')
	title.textContent = 'Messages'
	title.style.cssText = [
		'font-size:12px',
		'font-weight:700',
		'letter-spacing:0.08em',
		'text-transform:uppercase',
		'color:rgba(226, 232, 240, 0.8)',
	].join(';')
	const list = doc.createElement('div')
	list.style.cssText = [
		'display:flex',
		'flex-direction:column',
		'gap:8px',
	].join(';')
	root.appendChild(title)
	root.appendChild(list)
	host.appendChild(root)
	kodyWindow.__kodyLocalMessageLogRoot = root
	kodyWindow.__kodyLocalMessageLogList = list
	return { root, list }
}
function formatLocalMessageTimestamp(date) {
	try {
		return new Intl.DateTimeFormat(void 0, {
			hour: 'numeric',
			minute: '2-digit',
		}).format(date)
	} catch {
		return date.toLocaleTimeString()
	}
}
function appendLocalMessageLogEntry(text) {
	const refs = ensureLocalMessageLog()
	if (!refs) return false
	const doc = window.document
	const entry = doc.createElement('div')
	entry.style.cssText = [
		'padding:10px 12px',
		'border-radius:12px',
		'background:rgba(148, 163, 184, 0.18)',
		'border:1px solid rgba(148, 163, 184, 0.2)',
		'box-shadow:inset 0 1px 0 rgba(255,255,255,0.04)',
	].join(';')
	const timestamp = doc.createElement('div')
	timestamp.textContent = formatLocalMessageTimestamp(
		/* @__PURE__ */ new Date(),
	)
	timestamp.style.cssText = [
		'margin-bottom:4px',
		'font-size:11px',
		'font-weight:700',
		'letter-spacing:0.02em',
		'color:rgba(226, 232, 240, 0.72)',
	].join(';')
	const body = doc.createElement('div')
	body.textContent = typeof text === 'string' ? text : String(text ?? '')
	body.style.cssText = ['white-space:pre-wrap', 'word-break:break-word'].join(
		';',
	)
	entry.appendChild(timestamp)
	entry.appendChild(body)
	refs.list.appendChild(entry)
	refs.list.scrollTop = refs.list.scrollHeight
	return true
}
function coerceSessionEndpoints(value) {
	if (!isRecord2(value)) return null
	if (
		typeof value.source !== 'string' ||
		typeof value.execute !== 'string' ||
		typeof value.secrets !== 'string' ||
		typeof value.deleteSecret !== 'string'
	) {
		return null
	}
	return {
		source: value.source,
		execute: value.execute,
		secrets: value.secrets,
		deleteSecret: value.deleteSecret,
	}
}
function getBootstrap() {
	if (!isRecord2(kodyWindow.__kodyGeneratedUiBootstrap)) {
		return {
			mode: 'entry',
			params: {},
			appSession: null,
		}
	}
	const params = isRecord2(kodyWindow.__kodyGeneratedUiBootstrap.params)
		? kodyWindow.__kodyGeneratedUiBootstrap.params
		: {}
	const appSession = isRecord2(kodyWindow.__kodyGeneratedUiBootstrap.appSession)
		? {
				token:
					typeof kodyWindow.__kodyGeneratedUiBootstrap.appSession.token ===
					'string'
						? kodyWindow.__kodyGeneratedUiBootstrap.appSession.token
						: void 0,
				endpoints: coerceSessionEndpoints(
					kodyWindow.__kodyGeneratedUiBootstrap.appSession.endpoints,
				),
			}
		: null
	return {
		mode:
			kodyWindow.__kodyGeneratedUiBootstrap.mode === 'entry' ||
			kodyWindow.__kodyGeneratedUiBootstrap.mode === 'hosted' ||
			kodyWindow.__kodyGeneratedUiBootstrap.mode === 'mcp'
				? kodyWindow.__kodyGeneratedUiBootstrap.mode
				: 'entry',
		params,
		appSession:
			appSession && appSession.endpoints
				? {
						token: appSession.token,
						endpoints: appSession.endpoints,
					}
				: null,
	}
}
function initializeGeneratedUiRuntime() {
	if (kodyWindow.__kodyGeneratedUiRuntimeInitialized) {
		return
	}
	const bootstrap = getBootstrap()
	if (bootstrap.mode === 'entry') {
		return
	}
	kodyWindow.__kodyGeneratedUiRuntimeInitialized = true
	const runtimeMode = bootstrap.mode
	const runtimeParams = bootstrap.params
	const sessionToken =
		bootstrap.appSession && typeof bootstrap.appSession.token === 'string'
			? bootstrap.appSession.token
			: null
	const sessionEndpoints = bootstrap.appSession?.endpoints ?? null
	function getApiErrorMessage2(payload, fallback) {
		return typeof payload?.error === 'string' ? payload.error : fallback
	}
	function getRuntimeHooks() {
		return isRecord2(kodyWindow.__kodyGeneratedUiRuntimeHooks)
			? kodyWindow.__kodyGeneratedUiRuntimeHooks
			: {}
	}
	function getSessionRequestTarget2(type) {
		if (!sessionToken || !sessionEndpoints) {
			return null
		}
		const url =
			type === 'execute'
				? sessionEndpoints.execute
				: type === 'secrets'
					? sessionEndpoints.secrets
					: sessionEndpoints.deleteSecret
		if (typeof url !== 'string' || url.length === 0) {
			return null
		}
		return { url, token: sessionToken }
	}
	async function fetchJsonResponse2(input) {
		const headers = new Headers({
			Accept: 'application/json',
		})
		if (input.body) {
			headers.set('Content-Type', 'application/json')
		}
		if (input.token) {
			headers.set('Authorization', 'Bearer ' + input.token)
		}
		const response = await fetch(input.url, {
			method: input.method ?? 'GET',
			headers,
			body: input.body ? JSON.stringify(input.body) : void 0,
			cache: 'no-store',
			credentials: input.token ? 'omit' : 'include',
		})
		const payload = await response.json().catch(() => null)
		return { response, payload }
	}
	async function executeCodeWithHttp2(code) {
		const target = getSessionRequestTarget2('execute')
		if (!target) {
			throw new Error('Code execution is unavailable in this context.')
		}
		const { response, payload } = await fetchJsonResponse2({
			url: target.url,
			method: 'POST',
			body: { code },
			token: target.token,
		})
		if (!response.ok || !payload || payload.ok !== true) {
			throw new Error(getApiErrorMessage2(payload, 'Code execution failed.'))
		}
		return payload.result ?? null
	}
	async function saveSecretWithHttp(input) {
		const target = getSessionRequestTarget2('secrets')
		if (!target) {
			return {
				ok: false,
				error: 'Secret storage is unavailable in this context.',
			}
		}
		const { response, payload } = await fetchJsonResponse2({
			url: target.url,
			method: 'POST',
			body: {
				name: input.name,
				value: input.value,
				description: input.description ?? '',
				...(input.scope ? { scope: input.scope } : {}),
			},
			token: target.token,
		})
		if (!response.ok || !payload || payload.ok !== true) {
			return {
				ok: false,
				error: getApiErrorMessage2(payload, 'Unable to save secret.'),
			}
		}
		return {
			ok: true,
			secret: coerceSecretMetadata(payload.secret) ?? void 0,
		}
	}
	async function listSecretsWithHttp(scope) {
		const target = getSessionRequestTarget2('secrets')
		if (!target) return []
		const url = new URL(target.url)
		if (scope) {
			url.searchParams.set('scope', scope)
		}
		const { response, payload } = await fetchJsonResponse2({
			url: url.toString(),
			method: 'GET',
			token: target.token,
		})
		if (!response.ok || !Array.isArray(payload?.secrets)) {
			throw new Error(getApiErrorMessage2(payload, 'Unable to list secrets.'))
		}
		return payload.secrets
			.map((secret) => coerceSecretMetadata(secret))
			.filter((secret) => secret != null)
	}
	async function deleteSecretWithHttp(input) {
		const target = getSessionRequestTarget2('delete-secret')
		if (!target) {
			return {
				ok: false,
				error: 'Secret storage is unavailable in this context.',
			}
		}
		const { response, payload } = await fetchJsonResponse2({
			url: target.url,
			method: 'POST',
			body: {
				name: input.name,
				...(input.scope ? { scope: input.scope } : {}),
			},
			token: target.token,
		})
		if (!response.ok || !payload || payload.ok !== true) {
			return {
				ok: false,
				error: getApiErrorMessage2(payload, 'Unable to delete secret.'),
			}
		}
		return {
			ok: true,
			deleted: payload.deleted === true,
		}
	}
	function getOAuthStorage() {
		try {
			return window.localStorage
		} catch {
			return window.sessionStorage
		}
	}
	async function requestDisplayMode(mode) {
		if (runtimeMode === 'mcp') {
			const hook = getRuntimeHooks().requestDisplayMode
			return typeof hook === 'function' ? await hook(mode) : null
		}
		return null
	}
	async function executeCodeInCurrentContext(code) {
		if (runtimeMode === 'hosted') {
			return await executeCodeWithHttp2(code)
		}
		if (runtimeMode === 'mcp') {
			const hook = getRuntimeHooks().executeCode
			if (typeof hook === 'function') {
				return await hook(code)
			}
			return await executeCodeWithHttp2(code)
		}
		return null
	}
	async function saveSecretInCurrentContext(input) {
		return await saveSecretWithHttp(input)
	}
	async function listSecretsInCurrentContext(scope) {
		try {
			const response = await listSecretsWithHttp(scope ?? void 0)
			return Array.isArray(response) ? response : []
		} catch {
			return []
		}
	}
	async function deleteSecretInCurrentContext(input) {
		return await deleteSecretWithHttp(input)
	}
	const kodyWidget = {
		params: runtimeParams,
		sendMessage(text) {
			if (runtimeMode === 'hosted') {
				if (typeof text === 'string' && text.length > 0) {
					console.info('[kodyWidget] message:', text)
				}
				return false
			}
			if (runtimeMode === 'mcp') {
				const hook = getRuntimeHooks().sendMessage
				return typeof hook === 'function' ? hook(String(text ?? '')) : false
			}
			return appendLocalMessageLogEntry(text)
		},
		openLink(url) {
			if (runtimeMode === 'hosted') {
				if (typeof url !== 'string' || url.length === 0) return false
				window.open(url, '_blank', 'noopener,noreferrer')
				return true
			}
			if (runtimeMode === 'mcp') {
				const hook = getRuntimeHooks().openLink
				return typeof hook === 'function' ? hook(url) : false
			}
			return false
		},
		async requestDisplayMode(mode) {
			return await requestDisplayMode(mode)
		},
		async toggleFullscreen() {
			if (runtimeMode === 'hosted') {
				return 'inline'
			}
			return await requestDisplayMode('fullscreen')
		},
		async executeCode(code) {
			if (typeof code !== 'string' || code.length === 0) return null
			return await executeCodeInCurrentContext(code)
		},
		async saveSecret(input) {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Secret input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Secret name is required.' }
			}
			if (typeof input.value !== 'string' || input.value.length === 0) {
				return { ok: false, error: 'Secret value is required.' }
			}
			return await saveSecretInCurrentContext(input)
		},
		async saveSecrets(input) {
			if (!Array.isArray(input)) {
				return {
					ok: false,
					results: [
						{
							name: '',
							ok: false,
							error: 'Secret inputs must be an array.',
						},
					],
				}
			}
			const results = []
			for (const item of input) {
				if (!item || typeof item !== 'object') {
					results.push({
						name: '',
						ok: false,
						error: 'Each secret input must be an object.',
					})
					continue
				}
				const response = await kodyWidget.saveSecret(item)
				results.push({
					name: typeof item.name === 'string' ? item.name : '',
					ok: response.ok === true,
					...(response.ok === true && response.secret
						? { secret: response.secret }
						: {}),
					...(response.ok === true
						? {}
						: { error: response.error || 'Unable to save secret.' }),
				})
			}
			return {
				ok: results.every((result) => result.ok === true),
				results,
			}
		},
		async saveValue(input) {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Value input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Value name is required.' }
			}
			if (typeof input.value !== 'string' || input.value.length === 0) {
				return { ok: false, error: 'Value is required.' }
			}
			try {
				const result = await kodyWidget.executeCode(
					buildCodemodeCapabilityExecuteCode('value_set', {
						name: input.name,
						value: input.value,
						description:
							typeof input.description === 'string' ? input.description : '',
						...(coerceStorageScope(input.scope) ? { scope: input.scope } : {}),
					}),
				)
				const saved = coerceValueMetadata(
					isRecord2(result) ? result.value : null,
				)
				if (!saved) {
					return { ok: false, error: 'Unable to save value.' }
				}
				return {
					ok: true,
					value: saved,
				}
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error ? error.message : 'Unable to save value.',
				}
			}
		},
		async saveValues(input) {
			if (!Array.isArray(input)) {
				return {
					ok: false,
					results: [
						{
							name: '',
							ok: false,
							error: 'Value inputs must be an array.',
						},
					],
				}
			}
			const results = []
			for (const item of input) {
				if (!item || typeof item !== 'object') {
					results.push({
						name: '',
						ok: false,
						error: 'Each value input must be an object.',
					})
					continue
				}
				const response = await kodyWidget.saveValue(item)
				results.push({
					name: typeof item.name === 'string' ? item.name : '',
					ok: response.ok === true,
					...(response.ok === true && response.value
						? { value: response.value }
						: {}),
					...(response.ok === true
						? {}
						: { error: response.error || 'Unable to save value.' }),
				})
			}
			return {
				ok: results.every((result) => result.ok === true),
				results,
			}
		},
		async getValue(input) {
			if (!input || typeof input !== 'object') {
				throw new Error('Value input must be an object.')
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				throw new Error('Value name is required.')
			}
			const result = await kodyWidget.executeCode(
				buildCodemodeCapabilityExecuteCode('value_get', {
					name: input.name,
					...(coerceStorageScope(input.scope) ? { scope: input.scope } : {}),
				}),
			)
			return coerceValueMetadata(isRecord2(result) ? result.value : null)
		},
		async listValues(input) {
			const scope = coerceStorageScope(isRecord2(input) ? input.scope : void 0)
			const result = await kodyWidget.executeCode(
				buildCodemodeCapabilityExecuteCode('value_list', {
					...(scope ? { scope } : {}),
				}),
			)
			if (!isRecord2(result) || !Array.isArray(result.values)) return []
			return result.values
				.map((value) => coerceValueMetadata(value))
				.filter((value) => value != null)
		},
		async deleteValue(input) {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Value input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Value name is required.' }
			}
			const scope = coerceStorageScope(input.scope)
			if (!scope) {
				return { ok: false, error: 'Value scope is required.' }
			}
			try {
				const result = await kodyWidget.executeCode(
					buildCodemodeCapabilityExecuteCode('value_delete', {
						name: input.name,
						scope,
					}),
				)
				return {
					ok: true,
					deleted: isRecord2(result) ? result.deleted === true : false,
				}
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error ? error.message : 'Unable to delete value.',
				}
			}
		},
		async listSecrets(input) {
			const scope = coerceStorageScope(isRecord2(input) ? input.scope : void 0)
			return await listSecretsInCurrentContext(scope ?? void 0)
		},
		formToObject(form) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'formToObject requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			return formDataToObject(new FormData(resolvedForm))
		},
		fillFromSearchParams(form, mapping) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'fillFromSearchParams requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			const url = getTopLocationUrl()
			const mappingRecord = isRecord2(mapping) ? mapping : null
			const fieldNames = new Set(
				Array.from(resolvedForm.elements)
					.map((element) => ('name' in element ? element.name : ''))
					.filter((name) => typeof name === 'string' && name.length > 0),
			)
			for (const name of fieldNames) {
				const fieldName = String(name)
				const mappedValue = mappingRecord?.[fieldName]
				const paramName =
					typeof mappedValue === 'string' && mappedValue.length > 0
						? mappedValue
						: fieldName
				const values = url.searchParams.getAll(paramName)
				if (values.length === 0) continue
				setControlValues(resolvedForm, fieldName, values)
			}
			return kodyWidget.formToObject(resolvedForm)
		},
		persistForm(form, options) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'persistForm requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			if (
				!isRecord2(options) ||
				typeof options.storageKey !== 'string' ||
				options.storageKey.length === 0
			) {
				throw new Error('persistForm requires a storageKey option.')
			}
			const values = kodyWidget.formToObject(resolvedForm)
			const fieldNames = Array.isArray(options.fields)
				? options.fields.filter(
						(field) => typeof field === 'string' && field.length > 0,
					)
				: Object.keys(values)
			const persisted = {}
			for (const name of fieldNames) {
				if (!(name in values)) continue
				const value = values[name]
				const normalized = Array.isArray(value)
					? value
							.filter((entry) => typeof entry === 'string')
							.map((entry) => entry)
					: typeof value === 'string'
						? value
						: null
				if (normalized != null) {
					persisted[name] = normalized
				}
			}
			localStorage.setItem(options.storageKey, JSON.stringify(persisted))
			return persisted
		},
		restoreForm(form, options) {
			const resolvedForm = resolveFormReference(form)
			if (!(resolvedForm instanceof HTMLFormElement)) {
				throw new Error(
					'restoreForm requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			if (
				!isRecord2(options) ||
				typeof options.storageKey !== 'string' ||
				options.storageKey.length === 0
			) {
				throw new Error('restoreForm requires a storageKey option.')
			}
			const raw = localStorage.getItem(options.storageKey)
			if (!raw) return null
			let parsed = null
			try {
				parsed = JSON.parse(raw)
			} catch {
				return null
			}
			if (!isRecord2(parsed)) return null
			for (const [name, value] of Object.entries(parsed)) {
				setControlValues(resolvedForm, name, toStringArray(value))
			}
			return kodyWidget.formToObject(resolvedForm)
		},
		createOAuthState(key) {
			if (typeof key !== 'string' || key.length === 0) {
				throw new Error('createOAuthState requires a storage key.')
			}
			const state =
				globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
					? globalThis.crypto.randomUUID()
					: Math.random().toString(36).slice(2) +
						Math.random().toString(36).slice(2)
			const storage = getOAuthStorage()
			storage.setItem(key, state)
			return state
		},
		getOAuthState(key) {
			if (typeof key !== 'string' || key.length === 0) return null
			const storage = getOAuthStorage()
			return storage.getItem(key)
		},
		clearOAuthState(key) {
			if (typeof key !== 'string' || key.length === 0) return
			const storage = getOAuthStorage()
			storage.removeItem(key)
		},
		validateOAuthCallbackState(input) {
			if (
				!isRecord2(input) ||
				typeof input.key !== 'string' ||
				input.key.length === 0
			) {
				throw new Error('validateOAuthCallbackState requires a key.')
			}
			const storage = getOAuthStorage()
			const expectedState = storage.getItem(input.key)
			const returnedState =
				typeof input.returnedState === 'string' &&
				input.returnedState.length > 0
					? input.returnedState
					: null
			return {
				valid:
					typeof expectedState === 'string' &&
					expectedState.length > 0 &&
					returnedState != null &&
					expectedState === returnedState,
				expectedState,
				returnedState,
			}
		},
		readOAuthCallback(input) {
			const url = getTopLocationUrl(
				isRecord2(input) && typeof input.url === 'string' ? input.url : void 0,
			)
			const error = url.searchParams.get('error')
			const errorDescription = url.searchParams.get('error_description')
			if (error) {
				return {
					kind: 'error',
					error,
					errorDescription,
					callbackUrl: url.toString(),
				}
			}
			const code = url.searchParams.get('code')
			if (!code) {
				return { kind: 'none' }
			}
			const storage = getOAuthStorage()
			const state = url.searchParams.get('state')
			const expectedState =
				isRecord2(input) && typeof input.expectedStateKey === 'string'
					? storage.getItem(input.expectedStateKey)
					: null
			return {
				kind: 'success',
				code,
				state,
				callbackUrl: url.toString(),
				expectedState,
				stateMatches:
					expectedState != null && state != null
						? expectedState === state
						: null,
			}
		},
		async fetchWithSecrets(input) {
			const normalized = normalizeFetchWithSecretsInput(input)
			if (!normalized.ok) {
				return {
					ok: false,
					kind: 'execution_error',
					message: normalized.error,
				}
			}
			const fallbackSecretNames = normalizeSecretNameList(
				extractSecretNamesFromValue([
					normalized.value.url,
					Object.values(normalized.value.headers),
					normalized.value.body,
				]),
			)
			try {
				const result = await kodyWidget.executeCode(
					buildFetchWithSecretsExecuteCode(normalized.value),
				)
				return normalizeFetchWithSecretsResult(result)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (message.includes('not allowed for host')) {
					const approval = extractApprovalDetails(message, fallbackSecretNames)
					return {
						ok: false,
						kind: 'host_approval_required',
						approvalUrl: approval.approvalUrl,
						message: approval.message,
						host: approval.host,
						secretNames: approval.secretNames,
					}
				}
				return {
					ok: false,
					kind: 'execution_error',
					message,
				}
			}
		},
		async exchangePkceOAuthCode(input) {
			if (!isRecord2(input)) {
				return {
					ok: false,
					kind: 'execution_error',
					message: 'exchangePkceOAuthCode input must be an object.',
				}
			}
			if (
				typeof input.tokenUrl !== 'string' ||
				typeof input.code !== 'string' ||
				typeof input.redirectUri !== 'string' ||
				typeof input.clientId !== 'string' ||
				typeof input.codeVerifier !== 'string' ||
				input.tokenUrl.length === 0 ||
				input.code.length === 0 ||
				input.redirectUri.length === 0 ||
				input.clientId.length === 0 ||
				input.codeVerifier.length === 0
			) {
				return {
					ok: false,
					kind: 'execution_error',
					message:
						'exchangePkceOAuthCode requires tokenUrl, code, redirectUri, clientId, and codeVerifier.',
				}
			}
			const params = new URLSearchParams()
			params.set('grant_type', 'authorization_code')
			params.set('client_id', input.clientId)
			params.set('code_verifier', input.codeVerifier)
			params.set('code', input.code)
			params.set('redirect_uri', input.redirectUri)
			appendOAuthExtraParams(params, input.extraParams)
			try {
				const response = await fetch(input.tokenUrl, {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: params.toString(),
					cache: 'no-store',
					credentials: 'omit',
				})
				return normalizeFetchWithSecretsResult(
					await readOAuthFetchResult(response),
				)
			} catch (error) {
				return {
					ok: false,
					kind: 'execution_error',
					message:
						error instanceof Error
							? error.message
							: 'PKCE token exchange failed.',
				}
			}
		},
		async exchangeOAuthCodeWithSecrets(input) {
			if (!isRecord2(input)) {
				return {
					ok: false,
					kind: 'execution_error',
					message: 'exchangeOAuthCodeWithSecrets input must be an object.',
				}
			}
			if (
				typeof input.tokenUrl !== 'string' ||
				typeof input.code !== 'string' ||
				typeof input.redirectUri !== 'string' ||
				typeof input.clientId !== 'string' ||
				typeof input.clientSecretSecretName !== 'string' ||
				input.tokenUrl.length === 0 ||
				input.code.length === 0 ||
				input.redirectUri.length === 0 ||
				input.clientId.length === 0 ||
				input.clientSecretSecretName.length === 0
			) {
				return {
					ok: false,
					kind: 'execution_error',
					message:
						'exchangeOAuthCodeWithSecrets requires tokenUrl, code, redirectUri, clientId, and clientSecretSecretName.',
				}
			}
			const scope = coerceStorageScope(input.scope)
			const scopeSuffix = scope ? '|scope=' + scope : ''
			const params = new URLSearchParams()
			params.set('grant_type', 'authorization_code')
			params.set('client_id', input.clientId)
			params.set(
				'client_secret',
				'{{secret:' + input.clientSecretSecretName + scopeSuffix + '}}',
			)
			params.set('code', input.code)
			params.set('redirect_uri', input.redirectUri)
			appendOAuthExtraParams(params, input.extraParams)
			return await kodyWidget.fetchWithSecrets({
				url: input.tokenUrl,
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: params.toString(),
			})
		},
		async saveOAuthTokens(input) {
			if (!isRecord2(input) || !isRecord2(input.payload)) {
				return {
					ok: false,
					accessTokenSaved: false,
					refreshTokenSaved: false,
					error: 'saveOAuthTokens requires a payload object.',
					results: [],
				}
			}
			if (
				typeof input.accessTokenSecretName !== 'string' ||
				input.accessTokenSecretName.length === 0
			) {
				return {
					ok: false,
					accessTokenSaved: false,
					refreshTokenSaved: false,
					error: 'saveOAuthTokens requires an accessTokenSecretName.',
					results: [],
				}
			}
			const accessToken =
				typeof input.payload.access_token === 'string'
					? input.payload.access_token
					: ''
			const refreshToken =
				typeof input.payload.refresh_token === 'string'
					? input.payload.refresh_token
					: ''
			if (!accessToken) {
				return {
					ok: false,
					accessTokenSaved: false,
					refreshTokenSaved: false,
					error: 'OAuth payload did not include an access_token.',
					results: [],
				}
			}
			const secrets = [
				{
					name: input.accessTokenSecretName,
					value: accessToken,
					description:
						typeof input.accessTokenDescription === 'string'
							? input.accessTokenDescription
							: 'OAuth access token',
					scope: coerceStorageScope(input.scope) ?? void 0,
				},
			]
			if (
				refreshToken &&
				typeof input.refreshTokenSecretName === 'string' &&
				input.refreshTokenSecretName.length > 0
			) {
				secrets.push({
					name: input.refreshTokenSecretName,
					value: refreshToken,
					description:
						typeof input.refreshTokenDescription === 'string'
							? input.refreshTokenDescription
							: 'OAuth refresh token',
					scope: coerceStorageScope(input.scope) ?? void 0,
				})
			}
			const saved = await kodyWidget.saveSecrets(secrets)
			return {
				ok: saved.ok,
				accessTokenSaved: saved.results.some(
					(result) =>
						result.name === input.accessTokenSecretName && result.ok === true,
				),
				refreshTokenSaved:
					typeof input.refreshTokenSecretName === 'string' &&
					input.refreshTokenSecretName.length > 0
						? saved.results.some(
								(result) =>
									result.name === input.refreshTokenSecretName &&
									result.ok === true,
							)
						: false,
				error: saved.ok
					? void 0
					: saved.results.find((result) => result.ok !== true)?.error ||
						'Unable to save OAuth tokens.',
				results: saved.results,
			}
		},
		buildSecretForm(input) {
			if (!isRecord2(input) || !Array.isArray(input.fields)) {
				throw new Error(
					'buildSecretForm requires a form config object with fields.',
				)
			}
			const form = resolveFormReference(input.form)
			if (!(form instanceof HTMLFormElement)) {
				throw new Error(
					'buildSecretForm requires an HTMLFormElement or a selector that resolves to one.',
				)
			}
			const controller = {
				form,
				save: async () => {
					const values = kodyWidget.formToObject(form)
					const secrets = input.fields.map((field) => {
						if (!field || typeof field !== 'object') {
							throw new Error('Each secret field config must be an object.')
						}
						if (
							typeof field.inputName !== 'string' ||
							field.inputName.length === 0
						) {
							throw new Error('Each secret field config requires inputName.')
						}
						if (
							typeof field.secretName !== 'string' ||
							field.secretName.length === 0
						) {
							throw new Error('Each secret field config requires secretName.')
						}
						const rawValue = pickLastFormValue(values[field.inputName])
						if (typeof rawValue !== 'string' || rawValue.length === 0) {
							throw new Error(
								'Form field "' + field.inputName + '" is required.',
							)
						}
						return {
							name: field.secretName,
							value: rawValue,
							description:
								typeof field.description === 'string' ? field.description : '',
							scope: coerceStorageScope(field.scope) ?? void 0,
						}
					})
					const result = await kodyWidget.saveSecrets(secrets)
					if (result.ok) {
						if (typeof input.onSuccess === 'function') {
							await input.onSuccess(result, values)
						}
					} else if (typeof input.onError === 'function') {
						await input.onError(result, values)
					}
					return result
				},
				destroy: () => {
					form.removeEventListener('submit', handleSubmit)
				},
			}
			async function handleSubmit(event) {
				event.preventDefault()
				try {
					await controller.save()
				} catch (error) {
					if (typeof input.onError === 'function') {
						await input.onError(
							{
								ok: false,
								results: [
									{
										name: '',
										ok: false,
										error:
											error instanceof Error ? error.message : String(error),
									},
								],
							},
							kodyWidget.formToObject(form),
						)
						return
					}
					throw error
				}
			}
			form.addEventListener('submit', handleSubmit)
			return controller
		},
		async deleteSecret(input) {
			if (!input || typeof input !== 'object') {
				return { ok: false, error: 'Secret input must be an object.' }
			}
			if (typeof input.name !== 'string' || input.name.length === 0) {
				return { ok: false, error: 'Secret name is required.' }
			}
			return await deleteSecretInCurrentContext(input)
		},
	}
	kodyWindow.__kodyAppParams = runtimeParams
	kodyWindow.kodyWidget = kodyWidget
	kodyWindow.params = runtimeParams
	window.addEventListener('error', (event) => {
		console.error(
			'Generated UI app error:',
			event.error?.message ?? event.message ?? event.error ?? 'Unknown error',
		)
	})
	window.addEventListener('unhandledrejection', (event) => {
		console.error(
			'Generated UI app rejection:',
			event.reason?.message ?? event.reason ?? 'Unknown rejection',
		)
	})
}

// packages/shared/src/generated-ui-utils.ts
function escapeHtmlAttribute(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}
function decodeHtmlAttribute(value) {
	return value
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&')
}
function isNonNavigableUrl(value) {
	const normalizedValue = value.trim().toLowerCase()
	return (
		normalizedValue === '' ||
		normalizedValue.startsWith('#') ||
		normalizedValue.startsWith('//') ||
		normalizedValue.startsWith('about:') ||
		normalizedValue.startsWith('blob:') ||
		normalizedValue.startsWith('data:') ||
		normalizedValue.startsWith('javascript:') ||
		normalizedValue.startsWith('mailto:') ||
		normalizedValue.startsWith('tel:')
	)
}
function absolutizeUrl(value, baseHref) {
	if (!baseHref || isNonNavigableUrl(value)) {
		return value
	}
	try {
		return new URL(value).toString()
	} catch {}
	try {
		return new URL(value, baseHref).toString()
	} catch {
		return value
	}
}
function absolutizeSrcset(value, baseHref) {
	return value
		.split(',')
		.map((candidate) => {
			const trimmedCandidate = candidate.trim()
			if (trimmedCandidate.length === 0) {
				return ''
			}
			const [url, ...descriptorParts] = trimmedCandidate.split(/\s+/)
			if (!url) {
				return trimmedCandidate
			}
			return [absolutizeUrl(url, baseHref), ...descriptorParts]
				.filter((part) => part.length > 0)
				.join(' ')
		})
		.join(', ')
}

// packages/shared/src/generated-ui-documents.ts
function escapeInlineScriptSource(code) {
	return code.replace(/<\/script/gi, '<\\/script')
}
function injectIntoHtmlDocument(code, injection) {
	if (/<head\b[^>]*>/i.test(code)) {
		return code.replace(
			/<head\b[^>]*>/i,
			(match) => `${match}
${injection}
`,
		)
	}
	if (/<html\b[^>]*>/i.test(code)) {
		return code.replace(
			/<html\b[^>]*>/i,
			(match) => `${match}<head>${injection}</head>`,
		)
	}
	if (/<\/body>/i.test(code)) {
		return code.replace(
			/<\/body>/i,
			`${injection}
</body>`,
		)
	}
	return `${injection}
${code}`
}
function absolutizeHtmlAttributeUrls(code, baseHref) {
	if (!baseHref) {
		return code
	}
	return code.replace(/<[^>]+>/g, (tag) => {
		if (
			tag.startsWith('<!--') ||
			tag.startsWith('<!') ||
			tag.startsWith('<?')
		) {
			return tag
		}
		return tag.replace(
			/(^|\s)(href|src|action|formaction|poster|srcset)=("([^"]*)"|'([^']*)')/gi,
			(
				match,
				prefix,
				attributeName,
				quotedValue,
				doubleQuotedValue,
				singleQuotedValue,
			) => {
				const rawValue =
					typeof doubleQuotedValue === 'string'
						? doubleQuotedValue
						: singleQuotedValue
				const decodedValue = decodeHtmlAttribute(rawValue)
				const nextValue =
					attributeName.toLowerCase() === 'srcset'
						? absolutizeSrcset(decodedValue, baseHref)
						: absolutizeUrl(decodedValue, baseHref)
				if (nextValue === decodedValue) {
					return match
				}
				const quote = quotedValue.startsWith('"') ? '"' : "'"
				return `${prefix}${attributeName}=${quote}${escapeHtmlAttribute(nextValue)}${quote}`
			},
		)
	})
}
function buildHtmlDocumentFromFragment(code, headInjection) {
	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${headInjection}
	</head>
	<body data-kody-runtime="fragment">
${code}
	</body>
</html>
	`.trim()
}
function buildJavascriptDocument(code, headInjection) {
	const safeCode = escapeInlineScriptSource(code)
	return `
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		${headInjection}
	</head>
	<body data-kody-runtime="javascript">
		<div id="app" data-generated-ui-root></div>
		<script type="module">
${safeCode}
		</script>
	</body>
</html>
	`.trim()
}
function renderGeneratedUiDocument(input) {
	if (input.runtime === 'javascript') {
		return buildJavascriptDocument(input.code, input.headInjection)
	}
	const htmlSource = /<(?:!doctype|html|head|body)\b/i.test(input.code)
		? injectIntoHtmlDocument(input.code, input.headInjection)
		: buildHtmlDocumentFromFragment(input.code, input.headInjection)
	return absolutizeHtmlAttributeUrls(htmlSource, input.baseHref)
}
function renderGeneratedUiErrorDocument(message) {
	return `
<!doctype html>
<html lang="en">
	<body style="margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;">
		<pre style="margin:0;white-space:pre-wrap;word-break:break-word;">${message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>
	</body>
</html>
	`.trim()
}

// packages/shared/src/generated-ui-asset-paths.ts
var generatedUiRuntimeScriptPath = '/mcp-apps/generated-ui-runtime.js'
var generatedUiRuntimeStylesheetPath = '/mcp-apps/generated-ui-runtime.css'
function resolveGeneratedUiAssetUrl(assetPath, baseUrl) {
	if (!baseUrl) {
		return assetPath
	}
	try {
		return new URL(assetPath, baseUrl).toString()
	} catch {
		return assetPath
	}
}

// packages/worker/client/mcp-apps/generated-ui-runtime-controller.ts
function coerceJsonRecord(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return void 0
	}
	const out = /* @__PURE__ */ Object.create(null)
	for (const [key, entry] of Object.entries(value)) {
		out[key] = entry
	}
	return out
}
function isRecord3(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function normalizeMeasuredValue(value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return 0
	}
	return Math.ceil(value)
}
function measureElementDimensions(element) {
	if (!element) return { height: 0, width: 0 }
	const rect = element.getBoundingClientRect?.()
	return {
		height: Math.max(
			normalizeMeasuredValue(element.scrollHeight),
			normalizeMeasuredValue(element.offsetHeight),
			normalizeMeasuredValue(rect?.height),
		),
		width: Math.max(
			normalizeMeasuredValue(element.scrollWidth),
			normalizeMeasuredValue(element.offsetWidth),
			normalizeMeasuredValue(rect?.width),
		),
	}
}
function measureRenderedFrameSize(documentRef2) {
	if (!documentRef2) return null
	const documentElementSize = measureElementDimensions(
		documentRef2.documentElement,
	)
	const bodySize = measureElementDimensions(documentRef2.body)
	const nextSize = {
		height: Math.max(documentElementSize.height, bodySize.height),
		width: Math.max(documentElementSize.width, bodySize.width),
	}
	return nextSize.height > 0 || nextSize.width > 0 ? nextSize : null
}
function coerceRuntime(value) {
	return value === 'html' || value === 'javascript' ? value : void 0
}
function coerceAppSession(value) {
	if (!isRecord3(value)) return null
	if (
		typeof value.sessionId !== 'string' ||
		typeof value.expiresAt !== 'string'
	) {
		return null
	}
	const endpoints = coerceGeneratedUiEndpoints(value.endpoints)
	if (!endpoints) {
		return null
	}
	return {
		sessionId: value.sessionId,
		expiresAt: value.expiresAt,
		endpoints,
		token: typeof value.token === 'string' ? value.token : void 0,
	}
}
function coerceGeneratedUiEndpoints(value) {
	if (!isRecord3(value)) return null
	if (
		typeof value.source !== 'string' ||
		typeof value.execute !== 'string' ||
		typeof value.secrets !== 'string' ||
		typeof value.deleteSecret !== 'string'
	) {
		return null
	}
	try {
		const source = new URL(value.source)
		const execute = new URL(value.execute)
		const secrets = new URL(value.secrets)
		const deleteSecret = new URL(value.deleteSecret)
		const origin = source.origin
		const expectedOrigin = new URL('/', import.meta.url).origin
		if (origin !== expectedOrigin) {
			return null
		}
		if (
			execute.origin !== origin ||
			secrets.origin !== origin ||
			deleteSecret.origin !== origin
		) {
			return null
		}
		if (
			!source.pathname.startsWith('/ui-api/') ||
			!execute.pathname.startsWith('/ui-api/') ||
			!secrets.pathname.startsWith('/ui-api/') ||
			!deleteSecret.pathname.startsWith('/ui-api/')
		) {
			return null
		}
		return {
			source: source.toString(),
			execute: execute.toString(),
			secrets: secrets.toString(),
			deleteSecret: deleteSecret.toString(),
		}
	} catch {
		return null
	}
}
function injectRuntimeStateIntoDocument(code, params) {
	const runtimeBootstrap = {
		mode: 'mcp',
		params: params ?? {},
	}
	const bootstrapJson = escapeInlineScriptSource(
		JSON.stringify(runtimeBootstrap),
	)
	const bootstrapScript = `
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
window.__kodyAppParams = window.__kodyGeneratedUiBootstrap.params ?? {};
window.params = window.__kodyAppParams;
</script>
	`.trim()
	return injectIntoHtmlDocument(code, bootstrapScript)
}
function buildCodemodeCapabilityExecuteCode2(name, args = {}) {
	return [
		'async () => {',
		`  return await codemode[${JSON.stringify(name)}](${JSON.stringify(args)});`,
		'}',
	].join('\n')
}
function getHostToolErrorMessage(result) {
	if (!result || result.isError !== true) return null
	const structuredContent = isRecord3(result.structuredContent)
		? result.structuredContent
		: null
	const error = isRecord3(structuredContent?.error)
		? structuredContent.error
		: null
	return typeof error?.message === 'string'
		? error.message
		: 'Code execution failed.'
}
function readSavedAppSourceFromHostToolResult(result) {
	if (!result) {
		return {
			handled: false,
		}
	}
	const errorMessage = getHostToolErrorMessage(result)
	if (errorMessage) {
		return {
			handled: true,
			errorMessage,
		}
	}
	const structuredContent = isRecord3(result.structuredContent)
		? result.structuredContent
		: null
	const code =
		typeof structuredContent?.code === 'string' ? structuredContent.code : null
	if (!code) {
		return {
			handled: true,
			errorMessage: 'Saved app source is missing code.',
		}
	}
	return {
		handled: true,
		code,
		runtime: coerceRuntime(structuredContent?.runtime) ?? 'html',
	}
}
async function executeCodeWithHostTool(hostBridge, code) {
	const result = await hostBridge.callTool({
		name: 'execute',
		arguments: { code },
		timeoutMs: 9e4,
	})
	const errorMessage = getHostToolErrorMessage(result)
	if (errorMessage) {
		throw new Error(errorMessage)
	}
	const structuredContent = isRecord3(result?.structuredContent)
		? result.structuredContent
		: null
	return structuredContent?.result ?? null
}
function coerceRenderEnvelope(value) {
	if (!isRecord3(value)) return null
	const renderSource = value.renderSource ?? value.mode
	if (renderSource !== 'inline_code' && renderSource !== 'saved_app')
		return null
	const code =
		typeof value.sourceCode === 'string'
			? value.sourceCode
			: typeof value.code === 'string'
				? value.code
				: void 0
	const appId = typeof value.appId === 'string' ? value.appId : void 0
	const runtime = coerceRuntime(value.runtime) ?? (code ? 'html' : void 0)
	const params = coerceJsonRecord(value.params)
	const appSession = coerceAppSession(value.appSession)
	return { mode: renderSource, code, appId, runtime, params, appSession }
}
function getEnvelopeFromRenderData(renderData) {
	const toolOutput = isRecord3(renderData?.toolOutput)
		? renderData.toolOutput
		: void 0
	return coerceRenderEnvelope(toolOutput)
}
function getBaseHref() {
	try {
		return new URL('/', import.meta.url).toString()
	} catch {
		return null
	}
}
function readGeneratedUiBootstrap() {
	const win = globalThis.window
	const bootstrap = win?.__kodyGeneratedUiBootstrap
	if (!isRecord3(bootstrap)) {
		return { mode: 'entry' }
	}
	return {
		mode:
			bootstrap.mode === 'entry' ||
			bootstrap.mode === 'hosted' ||
			bootstrap.mode === 'mcp'
				? bootstrap.mode
				: 'entry',
		params: coerceJsonRecord(bootstrap.params),
		appSession: coerceAppSession(bootstrap.appSession),
	}
}
async function fetchJsonResponse(input) {
	const headers = new Headers({
		Accept: 'application/json',
	})
	if (input.body) {
		headers.set('Content-Type', 'application/json')
	}
	if (input.token) {
		headers.set('Authorization', `Bearer ${input.token}`)
	}
	const response = await fetch(input.url, {
		method: input.method ?? 'GET',
		headers,
		body: input.body ? JSON.stringify(input.body) : void 0,
		cache: 'no-store',
		credentials: input.token ? 'omit' : 'include',
	})
	const payload = await response.json().catch(() => null)
	return { response, payload }
}
function getApiErrorMessage(payload, fallback) {
	return typeof payload?.error === 'string' ? payload.error : fallback
}
function getSessionRequestTarget(appSession, type) {
	if (!appSession?.token) {
		return null
	}
	const url =
		type === 'execute'
			? appSession.endpoints.execute
			: type === 'secrets'
				? appSession.endpoints.secrets
				: appSession.endpoints.deleteSecret
	return {
		url,
		token: appSession.token,
	}
}
async function executeCodeWithHttp(appSession, code) {
	const target = getSessionRequestTarget(appSession, 'execute')
	if (!target) {
		return {
			handled: false,
			result: null,
		}
	}
	const { response, payload } = await fetchJsonResponse({
		url: target.url,
		method: 'POST',
		body: { code },
		token: target.token,
	})
	if (!response.ok || !payload || payload.ok !== true) {
		throw new Error(getApiErrorMessage(payload, 'Code execution failed.'))
	}
	return {
		handled: true,
		result: payload.result ?? null,
	}
}
function buildSavedUiEndpoint(baseHref, uiId, endpoint) {
	if (!baseHref) {
		return null
	}
	const path =
		endpoint === 'delete-secret'
			? `/ui-api/${encodeURIComponent(uiId)}/secrets/delete`
			: `/ui-api/${encodeURIComponent(uiId)}/${endpoint}`
	return new URL(path, baseHref).toString()
}
async function observeRenderedDocumentSize(hostBridge) {
	const documentRef2 = globalThis.document
	if (!documentRef2) {
		return () => {}
	}
	let lastMeasuredSize = null
	let sizeMeasurementScheduled = false
	const notifyMeasuredSize = async () => {
		const nextSize = measureRenderedFrameSize(documentRef2)
		if (
			!nextSize ||
			(lastMeasuredSize?.height === nextSize.height &&
				lastMeasuredSize?.width === nextSize.width)
		) {
			return
		}
		lastMeasuredSize = nextSize
		await hostBridge.sendSizeChanged(nextSize)
	}
	const scheduleMeasuredSizeNotification = () => {
		if (sizeMeasurementScheduled) return
		sizeMeasurementScheduled = true
		globalThis.requestAnimationFrame(() => {
			sizeMeasurementScheduled = false
			void notifyMeasuredSize()
		})
	}
	const observedElements = [
		documentRef2.documentElement,
		documentRef2.body,
	].filter((element) => element != null)
	let resizeObserver = null
	if (typeof ResizeObserver === 'function' && observedElements.length > 0) {
		resizeObserver = new ResizeObserver(() => {
			scheduleMeasuredSizeNotification()
		})
		for (const element of observedElements) {
			resizeObserver.observe(element)
		}
	}
	globalThis.addEventListener('resize', scheduleMeasuredSizeNotification)
	globalThis.setTimeout(() => {
		scheduleMeasuredSizeNotification()
	}, 0)
	scheduleMeasuredSizeNotification()
	return () => {
		resizeObserver?.disconnect()
		globalThis.removeEventListener('resize', scheduleMeasuredSizeNotification)
	}
}
function writeDocument(html) {
	const documentRef2 = globalThis.document
	if (!documentRef2) return
	documentRef2.open()
	documentRef2.write(html)
	documentRef2.close()
}
function buildHeadInjection(input) {
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		input.baseHref,
	)
	const runtimeScriptHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		input.baseHref,
	)
	const bootstrap = {
		mode: input.mode,
		params: input.params ?? {},
		...(input.appSession ? { appSession: input.appSession } : {}),
	}
	const bootstrapJson = escapeInlineScriptSource(JSON.stringify(bootstrap))
	return `
<link rel="stylesheet" href="${stylesheetHref}" />
<script>
window.__kodyGeneratedUiBootstrap = ${bootstrapJson};
</script>
<script type="module" src="${runtimeScriptHref}"></script>
	`.trim()
}
function installGeneratedUiRuntimeHooks(hooks) {
	globalThis.window.__kodyGeneratedUiRuntimeHooks = hooks
}
async function initializeRenderedMcpDocument(bootstrap) {
	let latestRenderData
	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-runtime',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			latestRenderData = isRecord3(renderData) ? renderData : void 0
		},
	})
	const requestDisplayMode = async (mode) => {
		const displayMode = latestRenderData?.displayMode
		const availableDisplayModes = Array.isArray(
			latestRenderData?.availableDisplayModes,
		)
			? latestRenderData.availableDisplayModes
			: []
		const nextMode =
			mode === 'fullscreen' && displayMode === 'fullscreen' ? 'inline' : mode
		if (!availableDisplayModes.includes(nextMode)) {
			return null
		}
		return (await hostBridge.requestDisplayMode(nextMode)) ?? null
	}
	installGeneratedUiRuntimeHooks({
		sendMessage: (text) => hostBridge.sendUserMessageWithFallback(text),
		openLink: (url) => hostBridge.openLink(url),
		requestDisplayMode,
		executeCode: async (code) => {
			const viaHttp = await executeCodeWithHttp(bootstrap.appSession, code)
			if (viaHttp.handled) {
				return viaHttp.result
			}
			return await executeCodeWithHostTool(hostBridge, code)
		},
	})
	initializeGeneratedUiRuntime()
	globalThis.window.addEventListener('message', (event) => {
		hostBridge.handleHostMessage(event.data)
	})
	void hostBridge.initialize()
	hostBridge.requestRenderData()
	void observeRenderedDocumentSize(hostBridge)
}
async function initializeShellHostDocument() {
	const baseHref = getBaseHref()
	let latestRenderData
	let latestEnvelope = null
	const hostBridge = createWidgetHostBridge({
		appInfo: {
			name: 'generated-ui-runtime',
			version: '1.0.0',
		},
		onRenderData: (renderData) => {
			const nextRenderData = isRecord3(renderData) ? renderData : void 0
			latestRenderData = nextRenderData
			void renderEnvelope(getEnvelopeFromRenderData(nextRenderData))
		},
	})
	const resolveSavedAppCode = async (appId, appSession) => {
		const hostToolResult = readSavedAppSourceFromHostToolResult(
			await hostBridge.callTool({
				name: 'ui_load_app_source',
				arguments: {
					app_id: appId,
				},
				timeoutMs: 9e4,
			}),
		)
		if (hostToolResult.handled && 'code' in hostToolResult) {
			return {
				code: hostToolResult.code,
				runtime: hostToolResult.runtime,
			}
		}
		const target = appSession?.token
			? (() => {
					const url = new URL(appSession.endpoints.source)
					if (!url.searchParams.has('app_id')) {
						url.searchParams.set('app_id', appId)
					}
					return {
						url: url.toString(),
						token: appSession.token,
					}
				})()
			: (() => {
					const url = buildSavedUiEndpoint(baseHref, appId, 'source')
					return url ? { url } : null
				})()
		if (!target) {
			throw new Error(
				hostToolResult.handled
					? hostToolResult.errorMessage
					: 'Failed to load saved app source.',
			)
		}
		try {
			const targetToken =
				'token' in target && typeof target.token === 'string'
					? target.token
					: void 0
			const { response, payload } = await fetchJsonResponse({
				url: target.url,
				method: 'GET',
				token: targetToken,
			})
			const app = isRecord3(payload?.app) ? payload.app : null
			if (!response.ok || !payload || payload.ok !== true || !app) {
				throw new Error(
					getApiErrorMessage(payload, 'Failed to load saved app source.'),
				)
			}
			const code = typeof app.code === 'string' ? app.code : null
			if (!code) {
				throw new Error('Saved app source is missing code.')
			}
			return {
				code,
				runtime: coerceRuntime(app.runtime) ?? 'html',
			}
		} catch (error) {
			if (hostToolResult.handled) {
				throw new Error(hostToolResult.errorMessage)
			}
			throw error
		}
	}
	const renderEnvelope = async (envelope) => {
		latestEnvelope = envelope
		if (!envelope) {
			return
		}
		const buildDocument = (code, runtime) =>
			renderGeneratedUiDocument({
				code,
				runtime,
				headInjection: buildHeadInjection({
					mode: 'mcp',
					params: envelope.params,
					appSession: envelope.appSession,
					baseHref,
				}),
				baseHref,
			})
		if (envelope.mode === 'inline_code') {
			if (!envelope.code) {
				writeDocument(
					renderGeneratedUiErrorDocument(
						'The tool result did not include inline code.',
					),
				)
				return
			}
			writeDocument(buildDocument(envelope.code, envelope.runtime ?? 'html'))
			return
		}
		if (!envelope.appId) {
			writeDocument(
				renderGeneratedUiErrorDocument(
					'The tool result did not include an app_id.',
				),
			)
			return
		}
		try {
			const resolved = await resolveSavedAppCode(
				envelope.appId,
				envelope.appSession,
			)
			if (latestEnvelope !== envelope) return
			writeDocument(buildDocument(resolved.code, resolved.runtime))
		} catch (error) {
			if (latestEnvelope !== envelope) return
			const message =
				error instanceof Error ? error.message : 'Unknown app loading error.'
			writeDocument(renderGeneratedUiErrorDocument(message))
		}
	}
	globalThis.window.addEventListener('message', (event) => {
		hostBridge.handleHostMessage(event.data)
	})
	void hostBridge.initialize()
	hostBridge.requestRenderData()
	void renderEnvelope(getEnvelopeFromRenderData(latestRenderData))
}
async function initializeGeneratedUiRuntimeEntry() {
	const documentRef2 = globalThis.document
	if (!documentRef2 || !globalThis.window) return
	const bootstrap = readGeneratedUiBootstrap()
	if (bootstrap.mode === 'entry') {
		await initializeShellHostDocument()
		return
	}
	if (bootstrap.mode === 'mcp') {
		await initializeRenderedMcpDocument(bootstrap)
		return
	}
	initializeGeneratedUiRuntime()
}
var documentRef = globalThis.document
if (documentRef?.readyState === 'loading') {
	documentRef.addEventListener(
		'DOMContentLoaded',
		() => {
			void initializeGeneratedUiRuntimeEntry()
		},
		{ once: true },
	)
} else if (documentRef) {
	void initializeGeneratedUiRuntimeEntry()
}
export {
	absolutizeHtmlAttributeUrls,
	buildCodemodeCapabilityExecuteCode2 as buildCodemodeCapabilityExecuteCode,
	injectIntoHtmlDocument,
	injectRuntimeStateIntoDocument,
	measureRenderedFrameSize,
	readSavedAppSourceFromHostToolResult,
}
