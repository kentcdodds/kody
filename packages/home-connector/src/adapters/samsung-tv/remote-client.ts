import dgram from 'node:dgram'
import { type SamsungTvAppStatus } from './types.ts'
import {
	getMockSamsungAppStatus,
	issueMockSamsungToken,
	launchMockSamsungApp,
	powerOnMockSamsungTv,
	sendMockSamsungRemoteKey,
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

type OpenSamsungRemoteSessionInput = {
	host: string
	token: string | null
	timeoutMs?: number
	name?: string
	webSocketFactory?: (url: string) => WebSocketLike
}

type SamsungRemoteSession = {
	socket: WebSocketLike
	token: string | null
}

const websocketOpenState = 1

const defaultWebSocketFactory = (url: string) =>
	new WebSocket(url) as unknown as WebSocketLike

function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

function createSamsungRemoteUrl(input: {
	host: string
	name: string
	token: string | null
}) {
	const encodedName = Buffer.from(input.name, 'utf8').toString('base64')
	const token = input.token ?? ''
	return `wss://${input.host}:8002/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(encodedName)}&token=${encodeURIComponent(token)}`
}

function createSamsungAuthorizationProbe() {
	return JSON.stringify({
		method: 'ms.channel.emit',
		params: {
			event: 'ed.installedApp.get',
			to: 'host',
		},
	})
}

function createSamsungRemoteKeyCommand(input: {
	key: string
	command?: 'Click' | 'Press' | 'Release'
}) {
	return JSON.stringify({
		method: 'ms.remote.control',
		params: {
			Cmd: input.command ?? 'Click',
			DataOfCmd: input.key,
			Option: 'false',
			TypeOfRemote: 'SendRemoteKey',
		},
	})
}

export async function openSamsungRemoteSession(
	input: OpenSamsungRemoteSessionInput,
): Promise<SamsungRemoteSession> {
	const timeoutMs = input.timeoutMs ?? 8_000
	const socket = (input.webSocketFactory ?? defaultWebSocketFactory)(
		createSamsungRemoteUrl({
			host: input.host,
			name: input.name ?? 'KodyHomeConnector',
			token: input.token,
		}),
	)
	return await new Promise<SamsungRemoteSession>((resolve, reject) => {
		let settled = false
		const timeout = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				socket.close()
			} catch {
				// ignore close failures while timing out
			}
			reject(
				new Error(
					'Samsung TV remote authorization timed out. Confirm the pairing prompt on the TV, then try again.',
				),
			)
		}, timeoutMs)
		const probeTimer = setTimeout(() => {
			if (settled || socket.readyState !== websocketOpenState) return
			socket.send(createSamsungAuthorizationProbe())
		}, 300)
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
			if (eventName === 'ms.channel.unauthorized') {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				clearTimeout(probeTimer)
				try {
					socket.close()
				} catch {
					// ignore close failures after unauthorized responses
				}
				reject(
					new Error(
						'Samsung TV remote authorization was rejected. Allow the device on the TV and try again.',
					),
				)
				return
			}
			if (eventName !== 'ms.channel.connect') return
			if (settled) return
			settled = true
			clearTimeout(timeout)
			clearTimeout(probeTimer)
			const data =
				(message['data'] as Record<string, unknown> | undefined) ?? {}
			resolve({
				socket,
				token:
					typeof data['token'] === 'string' && data['token'].length > 0
						? data['token']
						: input.token,
			})
		})
		socket.addEventListener('error', () => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			clearTimeout(probeTimer)
			reject(new Error('Samsung TV remote connection failed.'))
		})
		socket.addEventListener('close', () => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			clearTimeout(probeTimer)
			reject(
				new Error(
					'Samsung TV remote connection closed before authorization completed.',
				),
			)
		})
	})
}

async function parseSamsungJsonResponse(response: Response) {
	const responseText = await response.text()
	if (!responseText) return null
	return JSON.parse(responseText) as Record<string, unknown>
}

function isMockSamsungHost(host: string) {
	return host.endsWith('.mock.local')
}

function createWakeOnLanPacket(macAddress: string) {
	const normalized = macAddress.replaceAll(/[^a-fA-F0-9]/g, '')
	if (normalized.length !== 12) {
		throw new Error(
			`Samsung TV Wake-on-LAN requires a 48-bit MAC address. Received "${macAddress}".`,
		)
	}
	const macBytes = Buffer.from(normalized, 'hex')
	return Buffer.concat([
		Buffer.alloc(6, 0xff),
		...Array.from({ length: 16 }, () => macBytes),
	])
}

function createWakeOnLanTargets(host: string) {
	const targets = new Set<string>(['255.255.255.255'])
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
		const octets = host.split('.')
		targets.add(`${octets[0]}.${octets[1]}.${octets[2]}.255`)
	}
	return [...targets]
}

async function sendWakeOnLan(input: { host: string; macAddress: string }) {
	const packet = createWakeOnLanPacket(input.macAddress)
	const socket = dgram.createSocket('udp4')
	try {
		socket.setBroadcast(true)
		const targets = createWakeOnLanTargets(input.host)
		for (const target of targets) {
			for (const port of [9, 7]) {
				await new Promise<void>((resolve, reject) => {
					socket.send(packet, port, target, (error) => {
						if (error) {
							reject(error)
							return
						}
						resolve()
					})
				})
			}
		}
		return {
			targets,
			ports: [9, 7],
		}
	} finally {
		socket.close()
	}
}

export async function pairSamsungTv(input: {
	host: string
	token: string | null
	mocksEnabled: boolean
	timeoutMs?: number
}) {
	if (input.mocksEnabled && isMockSamsungHost(input.host)) {
		return {
			token: issueMockSamsungToken(input.host),
		}
	}
	const session = await openSamsungRemoteSession({
		host: input.host,
		token: input.token,
		timeoutMs: input.timeoutMs,
	})
	try {
		return {
			token: session.token,
		}
	} finally {
		session.socket.close()
	}
}

export async function fetchSamsungTvDeviceInfo(host: string) {
	const response = await fetch(`http://${host}:8001/api/v2/`)
	if (!response.ok) {
		throw new Error(
			`Samsung TV device info request failed with status ${response.status}.`,
		)
	}
	return (await parseSamsungJsonResponse(response)) ?? {}
}

export async function fetchSamsungTvAppStatus(input: {
	host: string
	appId: string
	mocksEnabled: boolean
}) {
	if (input.mocksEnabled && isMockSamsungHost(input.host)) {
		return getMockSamsungAppStatus(input.host, input.appId)
	}
	const response = await fetch(
		`http://${input.host}:8001/api/v2/applications/${encodeURIComponent(input.appId)}`,
	)
	if (response.status === 404) {
		return null
	}
	if (!response.ok) {
		throw new Error(
			`Samsung TV app status request failed with status ${response.status}.`,
		)
	}
	return (await parseSamsungJsonResponse(response)) as SamsungTvAppStatus | null
}

export async function launchSamsungTvApp(input: {
	host: string
	appId: string
	mocksEnabled: boolean
}) {
	if (input.mocksEnabled && isMockSamsungHost(input.host)) {
		return launchMockSamsungApp(input.host, input.appId)
	}
	const response = await fetch(
		`http://${input.host}:8001/api/v2/applications/${encodeURIComponent(input.appId)}`,
		{
			method: 'POST',
		},
	)
	if (!response.ok) {
		throw new Error(
			`Samsung TV app launch failed with status ${response.status}.`,
		)
	}
	return (await parseSamsungJsonResponse(response)) ?? { ok: true }
}

export async function sendSamsungTvRemoteKey(input: {
	host: string
	token: string | null
	key: string
	times?: number
	mocksEnabled: boolean
	timeoutMs?: number
}) {
	if (input.mocksEnabled && isMockSamsungHost(input.host)) {
		if (!validateMockSamsungToken(input.host, input.token)) {
			throw new Error(
				'Samsung TV mock remote authorization failed because the token is missing or invalid.',
			)
		}
		return {
			token: input.token,
			result: sendMockSamsungRemoteKey(input.host, input.key, input.times ?? 1),
		}
	}
	const session = await openSamsungRemoteSession({
		host: input.host,
		token: input.token,
		timeoutMs: input.timeoutMs,
	})
	try {
		for (let index = 0; index < (input.times ?? 1); index += 1) {
			session.socket.send(
				createSamsungRemoteKeyCommand({
					key: input.key,
				}),
			)
			await sleep(250)
		}
		return {
			token: session.token,
			result: {
				ok: true,
				key: input.key,
				times: input.times ?? 1,
			},
		}
	} finally {
		session.socket.close()
	}
}

export async function powerOnSamsungTv(input: {
	host: string
	macAddress: string
	mocksEnabled: boolean
}) {
	if (input.mocksEnabled && isMockSamsungHost(input.host)) {
		return {
			result: powerOnMockSamsungTv(input.host),
		}
	}
	const wakeResult = await sendWakeOnLan({
		host: input.host,
		macAddress: input.macAddress,
	})
	return {
		result: {
			ok: true,
			targets: wakeResult.targets,
			ports: wakeResult.ports,
		},
	}
}
