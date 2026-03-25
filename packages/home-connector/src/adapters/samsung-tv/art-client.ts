import {
	getMockSamsungArtMode,
	setMockSamsungArtMode,
	validateMockSamsungToken,
} from './mock-driver.ts'

type WebSocketLike = {
	readyState: number
	send(data: string): void
	close(): void
	addEventListener(
		type: 'open' | 'message' | 'error' | 'close',
		listener: (event: Event | MessageEvent) => void,
	): void
}

type SamsungArtSession = {
	socket: WebSocketLike
	token: string | null
}

const defaultWebSocketFactory = (url: string) =>
	new WebSocket(url) as unknown as WebSocketLike

function createSamsungArtUrl(input: {
	host: string
	name: string
	token: string | null
}) {
	const encodedName = Buffer.from(input.name, 'utf8').toString('base64')
	const token = input.token ?? ''
	return `wss://${input.host}:8002/api/v2/channels/com.samsung.art-app?name=${encodeURIComponent(encodedName)}&token=${encodeURIComponent(token)}`
}

function isMockSamsungHost(host: string) {
	return host.endsWith('.mock.local')
}

async function openSamsungArtSession(input: {
	host: string
	token: string | null
	timeoutMs?: number
	name?: string
	webSocketFactory?: (url: string) => WebSocketLike
}): Promise<SamsungArtSession> {
	const timeoutMs = input.timeoutMs ?? 8_000
	const socket = (input.webSocketFactory ?? defaultWebSocketFactory)(
		createSamsungArtUrl({
			host: input.host,
			name: input.name ?? 'KodyHomeConnector',
			token: input.token,
		}),
	)
	return await new Promise<SamsungArtSession>((resolve, reject) => {
		let settled = false
		let negotiatedToken = input.token
		const timeout = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				socket.close()
			} catch {
				// ignore close failures when timing out art session setup
			}
			reject(
				new Error(
					'Samsung TV art mode connection timed out while waiting for authorization.',
				),
			)
		}, timeoutMs)
		socket.addEventListener('message', (event) => {
			const raw = String((event as MessageEvent).data ?? '')
			let message: Record<string, unknown>
			try {
				message = JSON.parse(raw) as Record<string, unknown>
			} catch {
				return
			}
			const eventName =
				typeof message['event'] === 'string' ? message['event'] : ''
			if (eventName === 'ms.channel.connect') {
				const data =
					(message['data'] as Record<string, unknown> | undefined) ?? {}
				if (typeof data['token'] === 'string' && data['token'].length > 0) {
					negotiatedToken = data['token']
				}
				return
			}
			if (eventName !== 'ms.channel.ready') return
			if (settled) return
			settled = true
			clearTimeout(timeout)
			resolve({
				socket,
				token: negotiatedToken,
			})
		})
		socket.addEventListener('error', () => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			reject(new Error('Samsung TV art mode connection failed.'))
		})
		socket.addEventListener('close', () => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			reject(
				new Error(
					'Samsung TV art mode connection closed before it became ready.',
				),
			)
		})
	})
}

async function requestSamsungArtMode(input: {
	host: string
	token: string | null
	request: 'get_artmode_status' | 'set_artmode_status'
	value?: 'on' | 'off'
	mocksEnabled: boolean
}) {
	if (input.mocksEnabled && isMockSamsungHost(input.host)) {
		if (!validateMockSamsungToken(input.host, input.token)) {
			throw new Error(
				'Samsung TV mock art mode authorization failed because the token is missing or invalid.',
			)
		}
		if (input.request === 'get_artmode_status') {
			return {
				token: input.token,
				payload: {
					value: getMockSamsungArtMode(input.host),
				},
			}
		}
		return {
			token: input.token,
			payload: {
				...setMockSamsungArtMode(input.host, input.value ?? 'off'),
				status: input.value ?? 'off',
			},
		}
	}
	const session = await openSamsungArtSession({
		host: input.host,
		token: input.token,
	})
	try {
		const requestId = crypto.randomUUID()
		session.socket.send(
			JSON.stringify({
				method: 'ms.channel.emit',
				params: {
					event: 'art_app_request',
					to: 'host',
					data: JSON.stringify({
						request: input.request,
						value: input.value,
						id: requestId,
						request_id: requestId,
					}),
				},
			}),
		)
		const payload = await new Promise<Record<string, unknown>>(
			(resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(
						new Error(
							`Samsung TV art mode request "${input.request}" timed out.`,
						),
					)
				}, 8_000)
				session.socket.addEventListener('message', (event) => {
					const raw = String((event as MessageEvent).data ?? '')
					let message: Record<string, unknown>
					try {
						message = JSON.parse(raw) as Record<string, unknown>
					} catch {
						return
					}
					if (message['event'] !== 'd2d_service_message') return
					if (typeof message['data'] !== 'string') return
					const data = JSON.parse(message['data']) as Record<string, unknown>
					const candidateId = String(data['request_id'] ?? data['id'] ?? '')
					if (candidateId !== requestId) return
					clearTimeout(timeout)
					resolve(data)
				})
			},
		)
		return {
			token: session.token,
			payload,
		}
	} finally {
		session.socket.close()
	}
}

export async function getSamsungTvArtMode(input: {
	host: string
	token: string | null
	mocksEnabled: boolean
}) {
	const result = await requestSamsungArtMode({
		host: input.host,
		token: input.token,
		request: 'get_artmode_status',
		mocksEnabled: input.mocksEnabled,
	})
	const mode = String(result.payload['value'] ?? 'off') === 'on' ? 'on' : 'off'
	return {
		token: result.token,
		mode,
	}
}

export async function setSamsungTvArtMode(input: {
	host: string
	token: string | null
	mode: 'on' | 'off'
	mocksEnabled: boolean
}) {
	const result = await requestSamsungArtMode({
		host: input.host,
		token: input.token,
		request: 'set_artmode_status',
		value: input.mode,
		mocksEnabled: input.mocksEnabled,
	})
	return {
		token: result.token,
		mode: input.mode,
		response: result.payload,
	}
}
