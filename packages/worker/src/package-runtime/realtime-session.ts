import { DurableObject } from 'cloudflare:workers'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildFacetName } from '#mcp/app-runner-facet-names.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { buildPackageAppWorker } from './package-app.ts'

const sessionStateStorageKey = 'package-realtime-state'
const sessionTagPrefix = 'session:'
const facetTagPrefix = 'facet:'

type PersistedPackageRealtimeSession = {
	id: string
	facet: string
	connectedAt: string
	lastSeenAt: string
	topics: Array<string>
}

type PackageRealtimeBindingState = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}

type PackageRealtimeState = {
	binding: PackageRealtimeBindingState | null
	sessions: Record<string, PersistedPackageRealtimeSession>
}

type PackageRealtimeSessionRecord = {
	id: string
	facet: string
	topics: Array<string>
	connectedAt: string
	lastSeenAt: string
}

type PackageRealtimeSessionOutput = {
	session_id: string
	facet: string
	topics: Array<string>
	connected_at: string
	last_seen_at: string
}

export type PackageRealtimeEmitResult = {
	delivered: boolean
	reason?: string
}

export type PackageRealtimeBroadcastResult = {
	deliveredCount: number
	sessionIds: Array<string>
}

export type PackageRealtimeListResult = {
	sessions: Array<PackageRealtimeSessionOutput>
}

type PackageRealtimeEventRequestInfo = {
	url: string
	method: string
	headers: Record<string, string>
}

type PackageRealtimeIncomingMessage =
	| {
			kind: 'text'
			text: string
			json: unknown | null
	  }
	| {
			kind: 'binary'
			text: string | null
			json: unknown | null
	  }

type PackageRealtimeAction =
	| {
			type: 'send'
			data: unknown
	  }
	| {
			type: 'subscribe'
			topic: string
	  }
	| {
			type: 'unsubscribe'
			topic: string
	  }
	| {
			type: 'emit'
			sessionId: string
			data: unknown
	  }
	| {
			type: 'broadcast'
			data: unknown
			topic?: string | null
			facet?: string | null
	  }
	| {
			type: 'close'
			code?: number | null
			reason?: string | null
	  }

type PackageRealtimeHookResult =
	| {
			actions?: Array<PackageRealtimeAction> | null
	  }
	| Array<PackageRealtimeAction>
	| null
	| undefined

type PackageRealtimeHookInput = {
	event: 'connect' | 'message' | 'disconnect'
	facet: string
	session: PackageRealtimeSessionRecord
	request?: PackageRealtimeEventRequestInfo | null
	message?: PackageRealtimeIncomingMessage | null
	close?: {
		code: number
		reason: string
		wasClean: boolean
	} | null
}

type PackageRealtimeHookContext = {
	userId: string
	packageId: string
	kodyId: string
	baseUrl: string
}

type PackageRealtimeConnectPayload = {
	binding: PackageRealtimeBindingState
	facet?: string | null
	request: PackageRealtimeEventRequestInfo
}

type PackageRealtimeEmitPayload = {
	binding: PackageRealtimeBindingState
	sessionId: string
	data: unknown
}

type PackageRealtimeBroadcastPayload = {
	binding: PackageRealtimeBindingState
	data: unknown
	topic?: string | null
	facet?: string | null
}

type PackageRealtimeListPayload = {
	binding: PackageRealtimeBindingState
	facet?: string | null
	topic?: string | null
}

function createInitialState(): PackageRealtimeState {
	return {
		binding: null,
		sessions: {},
	}
}

function sessionTag(sessionId: string) {
	return `${sessionTagPrefix}${sessionId}`
}

function facetTag(facet: string) {
	return `${facetTagPrefix}${facet}`
}

function pickString(...values: Array<unknown>) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim()
		}
	}
	return null
}

function toPlainHeaders(headers: Headers) {
	return Object.fromEntries(headers.entries())
}

function serializeOutboundMessage(value: unknown) {
	if (typeof value === 'string') {
		return value
	}
	return JSON.stringify(value)
}

function decodeInboundMessage(
	message: string | ArrayBuffer,
): PackageRealtimeIncomingMessage {
	if (typeof message === 'string') {
		try {
			return {
				kind: 'text',
				text: message,
				json: JSON.parse(message),
			}
		} catch {
			return {
				kind: 'text',
				text: message,
				json: null,
			}
		}
	}
	const text = (() => {
		try {
			return new TextDecoder().decode(message)
		} catch {
			return null
		}
	})()
	if (text == null) {
		return {
			kind: 'binary',
			text: null,
			json: null,
		}
	}
	try {
		return {
			kind: 'binary',
			text,
			json: JSON.parse(text),
		}
	} catch {
		return {
			kind: 'binary',
			text,
			json: null,
		}
	}
}

function normalizeHookActions(result: PackageRealtimeHookResult) {
	if (Array.isArray(result)) {
		return result
	}
	if (!result || typeof result !== 'object') {
		return []
	}
	return Array.isArray(result.actions) ? result.actions : []
}

function createSessionRecord(
	session: PersistedPackageRealtimeSession,
): PackageRealtimeSessionRecord {
	return {
		id: session.id,
		facet: session.facet,
		topics: [...session.topics],
		connectedAt: session.connectedAt,
		lastSeenAt: session.lastSeenAt,
	}
}

function createSessionOutput(
	session: PersistedPackageRealtimeSession,
): PackageRealtimeSessionOutput {
	return {
		session_id: session.id,
		facet: session.facet,
		topics: [...session.topics],
		connected_at: session.connectedAt,
		last_seen_at: session.lastSeenAt,
	}
}

async function resolvePackageAppWorker(input: {
	env: Env
	binding: PackageRealtimeBindingState
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.binding.userId,
		packageId: input.binding.packageId,
	})
	if (!savedPackage || !savedPackage.hasApp) {
		throw new Error('Saved package app was not found.')
	}
	const packageSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.binding.baseUrl,
		userId: input.binding.userId,
		sourceId: input.binding.sourceId,
	})
	const callerContext = createMcpCallerContext({
		baseUrl: input.binding.baseUrl,
		user: {
			userId: input.binding.userId,
			email: '',
			displayName: `package:${input.binding.packageId}`,
		},
		storageContext: {
			sessionId: null,
			appId: input.binding.packageId,
			storageId: input.binding.packageId,
		},
		repoContext: null,
	})
	return await buildPackageAppWorker({
		env: input.env,
		baseUrl: input.binding.baseUrl,
		userId: input.binding.userId,
		savedPackage: {
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
			sourceId: savedPackage.sourceId,
			publishedCommit: packageSource.source.published_commit,
			manifestPath: packageSource.source.manifest_path,
			sourceRoot: packageSource.source.source_root,
		},
		sourceFiles: packageSource.files,
		runtime: {
			callerContext,
		},
	})
}

export class PackageRealtimeSession extends DurableObject<Env> {
	private stateSnapshot: PackageRealtimeState = createInitialState()
	private sessionIds = new WeakMap<WebSocket, string | null>()

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	private async restoreState() {
		const stored =
			await this.ctx.storage.get<PackageRealtimeState>(sessionStateStorageKey)
		if (!stored) return
		this.stateSnapshot = {
			binding: stored.binding ?? null,
			sessions: stored.sessions ?? {},
		}
	}

	private async persistState() {
		await this.ctx.storage.put(sessionStateStorageKey, this.stateSnapshot)
	}

	private async initializeBinding(binding: PackageRealtimeBindingState) {
		if (!this.stateSnapshot.binding) {
			this.stateSnapshot.binding = binding
			await this.persistState()
			return
		}
		const existing = this.stateSnapshot.binding
		if (
			existing.userId !== binding.userId ||
			existing.packageId !== binding.packageId ||
			existing.sourceId !== binding.sourceId
		) {
			throw new Error('Realtime session binding mismatch.')
		}
		if (existing.baseUrl !== binding.baseUrl) {
			this.stateSnapshot.binding = {
				...existing,
				baseUrl: binding.baseUrl,
			}
			await this.persistState()
		}
	}

	private stashSessionId(ws: WebSocket, sessionId: string) {
		this.sessionIds.set(ws, sessionId)
		try {
			ws.serializeAttachment(sessionId)
		} catch {
			// Best effort; keep in-memory map for local runtimes without attachments.
		}
	}

	private loadSessionId(ws: WebSocket) {
		if (this.sessionIds.has(ws)) {
			return this.sessionIds.get(ws) ?? null
		}
		let sessionId: string | null = null
		try {
			const attachment = ws.deserializeAttachment()
			if (typeof attachment === 'string' && attachment.trim().length > 0) {
				sessionId = attachment.trim()
			}
		} catch {
			// Ignore missing attachment support.
		}
		this.sessionIds.set(ws, sessionId)
		return sessionId
	}

	private getSocketBySessionId(sessionId: string) {
		return this.ctx.getWebSockets(sessionTag(sessionId))[0] ?? null
	}

	private listSessions(input?: {
		facet?: string | null
		topic?: string | null
	}): Array<PackageRealtimeSessionOutput> {
		const facet = buildFacetName(input?.facet)
		const topic = pickString(input?.topic)
		return Object.values(this.stateSnapshot.sessions)
			.filter((session) => {
				if (input?.facet != null && session.facet !== facet) return false
				if (topic && !session.topics.includes(topic)) return false
				return this.getSocketBySessionId(session.id) != null
			})
			.map(createSessionOutput)
	}

	private async emitToSession(sessionId: string, data: unknown) {
		const socket = this.getSocketBySessionId(sessionId)
		if (!socket) {
			if (this.stateSnapshot.sessions[sessionId]) {
				delete this.stateSnapshot.sessions[sessionId]
				await this.persistState()
			}
			return { delivered: false, reason: 'session_not_connected' as const }
		}
		socket.send(serializeOutboundMessage(data))
		return { delivered: true as const }
	}

	private async broadcast(input: {
		facet?: string | null
		topic?: string | null
		data: unknown
	}) {
		const sessions = this.listSessions({
			facet: input.facet,
			topic: input.topic,
		})
		let deliveredCount = 0
		for (const session of sessions) {
			const delivered = await this.emitToSession(
				session.session_id,
				input.data,
			)
			if (delivered.delivered) {
				deliveredCount += 1
			}
		}
		return {
			deliveredCount,
			sessionIds: sessions.map((session) => session.session_id),
		}
	}

	private async resolveRealtimeHookResult(input: {
		binding: PackageRealtimeBindingState
		payload: PackageRealtimeHookInput
	}) {
		const appWorker = await resolvePackageAppWorker({
			env: this.env,
			binding: input.binding,
		})
		const entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName) as {
			handleRealtimeEvent?: (
				payload: PackageRealtimeHookInput & PackageRealtimeHookContext,
			) => Promise<PackageRealtimeHookResult>
		}
		if (typeof entrypoint.handleRealtimeEvent !== 'function') {
			return []
		}
		const result = await entrypoint.handleRealtimeEvent({
			...input.payload,
			userId: input.binding.userId,
			packageId: input.binding.packageId,
			kodyId: input.binding.kodyId,
			baseUrl: input.binding.baseUrl,
		})
		return normalizeHookActions(result)
	}

	private async applyHookActions(
		sessionId: string,
		actions: Array<PackageRealtimeAction>,
		sessionOverride?: PersistedPackageRealtimeSession | null,
	) {
		const session = sessionOverride ?? this.stateSnapshot.sessions[sessionId]
		if (!session) return
		let shouldPersist = false
		for (const action of actions) {
			if (!action || typeof action !== 'object' || !('type' in action)) continue
			switch (action.type) {
				case 'send':
					await this.emitToSession(sessionId, action.data)
					break
				case 'subscribe': {
					const topic = pickString(action.topic)
					if (!topic || session.topics.includes(topic)) break
					session.topics.push(topic)
					shouldPersist = true
					break
				}
				case 'unsubscribe': {
					const topic = pickString(action.topic)
					if (!topic) break
					const nextTopics = session.topics.filter((value) => value !== topic)
					if (nextTopics.length === session.topics.length) break
					session.topics = nextTopics
					shouldPersist = true
					break
				}
				case 'emit':
					await this.emitToSession(action.sessionId, action.data)
					break
				case 'broadcast':
					await this.broadcast({
						facet: action.facet,
						topic: action.topic,
						data: action.data,
					})
					break
				case 'close': {
					const socket = this.getSocketBySessionId(sessionId)
					if (socket) {
						socket.close(action.code ?? 1000, action.reason ?? 'closed')
					}
					break
				}
			}
		}
		if (shouldPersist && this.stateSnapshot.sessions[sessionId]) {
			this.stateSnapshot.sessions[sessionId] = session
			await this.persistState()
		}
	}

	private async handleConnectRequest(payload: PackageRealtimeConnectPayload) {
		await this.initializeBinding(payload.binding)
		const facet = buildFacetName(payload.facet)
		const pair = new WebSocketPair()
		const sockets = Object.values(pair)
		const client = sockets[0]
		const server = sockets[1]
		if (!client || !server) {
			throw new Error('Failed to create WebSocket pair.')
		}
		const sessionId = crypto.randomUUID()
		const now = new Date().toISOString()
		this.ctx.acceptWebSocket(server, [sessionTag(sessionId), facetTag(facet)])
		this.stashSessionId(server, sessionId)
		this.stateSnapshot.sessions[sessionId] = {
			id: sessionId,
			facet,
			connectedAt: now,
			lastSeenAt: now,
			topics: [],
		}
		await this.persistState()
		const actions = await this.resolveRealtimeHookResult({
			binding: payload.binding,
			payload: {
				event: 'connect',
				facet,
				session: createSessionRecord(this.stateSnapshot.sessions[sessionId]),
				request: payload.request,
			},
		})
		await this.applyHookActions(sessionId, actions)
		return new Response(null, {
			status: 101,
			webSocket: client,
		})
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.headers.get('Upgrade') === 'websocket') {
			const body = (await request.json()) as PackageRealtimeConnectPayload
			return await this.handleConnectRequest(body)
		}

		if (request.method === 'POST' && url.pathname.endsWith('/sessions')) {
			const body = (await request.json().catch(() => null)) as
				| PackageRealtimeListPayload
				| null
			if (!body) {
				return Response.json({ sessions: [] })
			}
			await this.initializeBinding(body.binding)
			return Response.json({
				sessions: this.listSessions({
					facet: body.facet,
					topic: body.topic,
				}),
			})
		}

		if (request.method === 'POST' && url.pathname.endsWith('/emit')) {
			const body = (await request.json()) as PackageRealtimeEmitPayload
			await this.initializeBinding(body.binding)
			return Response.json(
				await this.emitToSession(body.sessionId, body.data),
			)
		}

		if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
			const body = (await request.json()) as PackageRealtimeBroadcastPayload
			await this.initializeBinding(body.binding)
			return Response.json(
				await this.broadcast({
					facet: body.facet,
					topic: body.topic,
					data: body.data,
				}),
			)
		}

		if (request.method === 'POST' && url.pathname.endsWith('/disconnect')) {
			const body = (await request.json()) as {
				binding: PackageRealtimeBindingState
				sessionId: string
				code?: number | null
				reason?: string | null
			}
			await this.initializeBinding(body.binding)
			const socket = this.getSocketBySessionId(body.sessionId)
			if (socket) {
				socket.close(body.code ?? 1000, body.reason ?? 'closed')
			}
			return Response.json({ ok: true })
		}

		return new Response('Not found', { status: 404 })
	}

	webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): void | Promise<void> {
		void this.handleWebSocketMessage(ws, message)
	}

	webSocketClose(
		ws: WebSocket,
		_code: number,
		reason: string,
		wasClean: boolean,
	): void {
		void this.handleDisconnect(ws, {
			code: _code,
			reason,
			wasClean,
		})
	}

	private async handleWebSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	) {
		const sessionId = this.loadSessionId(ws)
		if (!sessionId) return
		const session = this.stateSnapshot.sessions[sessionId]
		const binding = this.stateSnapshot.binding
		if (!session || !binding) return
		session.lastSeenAt = new Date().toISOString()
		await this.persistState()
		const actions = await this.resolveRealtimeHookResult({
			binding,
			payload: {
				event: 'message',
				facet: session.facet,
				session: createSessionRecord(session),
				message: decodeInboundMessage(message),
			},
		})
		await this.applyHookActions(sessionId, actions)
	}

	private async handleDisconnect(
		ws: WebSocket,
		close: {
			code: number
			reason: string
			wasClean: boolean
		},
	) {
		const sessionId = this.loadSessionId(ws)
		if (!sessionId) return
		const session = this.stateSnapshot.sessions[sessionId]
		const binding = this.stateSnapshot.binding
		delete this.stateSnapshot.sessions[sessionId]
		await this.persistState()
		if (!session || !binding) return
		const actions = await this.resolveRealtimeHookResult({
			binding,
			payload: {
				event: 'disconnect',
				facet: session.facet,
				session: createSessionRecord(session),
				close,
			},
		})
		await this.applyHookActions(sessionId, actions, session)
	}
}

type PackageRealtimeSessionRpc = {
	fetch: (request: Request) => Promise<Response>
}

function buildRealtimeSessionName(input: {
	userId: string
	packageId: string
}) {
	return JSON.stringify([input.userId, input.packageId])
}

function getPackageRealtimeNamespace(env: Env) {
	return env.PACKAGE_REALTIME_SESSION
}

function getPackageRealtimeStub(input: {
	env: Env
	userId: string
	packageId: string
}): PackageRealtimeSessionRpc {
	const namespace = getPackageRealtimeNamespace(input.env)
	if (!namespace) {
		throw new Error('Missing PACKAGE_REALTIME_SESSION binding.')
	}
	const id = namespace.idFromName(
		buildRealtimeSessionName({
			userId: input.userId,
			packageId: input.packageId,
		}),
	)
	return namespace.get(id) as unknown as PackageRealtimeSessionRpc
}

export function packageRealtimeSessionRpc(input: {
	env: Env
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}) {
	const binding: PackageRealtimeBindingState = {
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		sourceId: input.sourceId,
		baseUrl: input.baseUrl,
	}
	const stub = getPackageRealtimeStub(input)
	return {
		async connect(request: Request, facet?: string | null) {
			const forwardedRequest = new Request(request.url, {
				method: 'POST',
				headers: request.headers,
				body: JSON.stringify({
					binding,
					facet,
					request: {
						url: request.url,
						method: request.method,
						headers: toPlainHeaders(request.headers),
					},
				} satisfies PackageRealtimeConnectPayload),
			})
			forwardedRequest.headers.set('Upgrade', 'websocket')
			return await stub.fetch(forwardedRequest)
		},
		async emit(
			sessionId: string,
			data: unknown,
		): Promise<PackageRealtimeEmitResult> {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/emit', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						sessionId,
						data,
					} satisfies PackageRealtimeEmitPayload),
				}),
			)
			return (await response.json()) as PackageRealtimeEmitResult
		},
		async broadcast(input2: {
			data: unknown
			topic?: string | null
			facet?: string | null
		}): Promise<PackageRealtimeBroadcastResult> {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/broadcast', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						data: input2.data,
						topic: input2.topic,
						facet: input2.facet,
					} satisfies PackageRealtimeBroadcastPayload),
				}),
			)
			return (await response.json()) as PackageRealtimeBroadcastResult
		},
		async listSessions(input2?: {
			topic?: string | null
			facet?: string | null
		}): Promise<PackageRealtimeListResult> {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/sessions', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						topic: input2?.topic,
						facet: input2?.facet,
					} satisfies PackageRealtimeListPayload),
				}),
			)
			return (await response.json()) as PackageRealtimeListResult
		},
		async disconnect(sessionId: string, input2?: { code?: number; reason?: string }) {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/disconnect', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						sessionId,
						code: input2?.code,
						reason: input2?.reason,
					}),
				}),
			)
			return await response.json()
		},
	}
}
