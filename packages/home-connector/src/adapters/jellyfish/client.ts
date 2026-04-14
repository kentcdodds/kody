import { isMockJellyfishHost, sendMockJellyfishCommand } from './mock-driver.ts'
import {
	type JellyfishDiscoveredController,
	jellyfishDefaultPort,
} from './types.ts'

function normalizeControllerId(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

function extractHostnameFromZones(
	response: Record<string, unknown>,
): string | null {
	const zones = response['zones']
	if (!zones || typeof zones !== 'object' || Array.isArray(zones)) return null
	for (const zone of Object.values(zones as Record<string, unknown>)) {
		if (!zone || typeof zone !== 'object' || Array.isArray(zone)) continue
		const portMap = (zone as Record<string, unknown>)['portMap']
		if (!Array.isArray(portMap)) continue
		for (const entry of portMap) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
			const ctlrName = (entry as Record<string, unknown>)['ctlrName']
			if (typeof ctlrName === 'string' && ctlrName.trim()) {
				return ctlrName.trim()
			}
		}
	}
	return null
}

function extractFirmwareVersion(response: Record<string, unknown>) {
	const version = response['version']
	if (typeof version === 'string' && version.trim()) return version.trim()
	if (
		version &&
		typeof version === 'object' &&
		!Array.isArray(version) &&
		typeof (version as Record<string, unknown>)['ver'] === 'string'
	) {
		return String((version as Record<string, unknown>)['ver']).trim()
	}
	return null
}

async function websocketDataToString(data: unknown) {
	if (typeof data === 'string') return data
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
			'utf8',
		)
	}
	if (data instanceof Blob) return await data.text()
	return String(data)
}

export async function sendJellyfishCommand(input: {
	host: string
	port?: number
	command: Record<string, unknown>
	timeoutMs?: number
	mocksEnabled: boolean
}): Promise<Record<string, unknown>> {
	if (input.mocksEnabled && isMockJellyfishHost(input.host)) {
		return (await sendMockJellyfishCommand(
			input.host,
			input.command,
		)) as Record<string, unknown>
	}

	const port = input.port ?? jellyfishDefaultPort
	const timeoutMs = input.timeoutMs ?? 5_000
	const payload = JSON.stringify(input.command)

	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		const ws = new WebSocket(`ws://${input.host}:${String(port)}`)
		let settled = false

		const finish = (callback: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			try {
				callback()
			} finally {
				try {
					ws.close()
				} catch {
					// Ignore close failures after resolve/reject.
				}
			}
		}

		const timer = setTimeout(() => {
			finish(() => {
				reject(
					new Error(
						`JellyFish command timed out after ${timeoutMs}ms for ${input.host}:${String(port)}.`,
					),
				)
			})
		}, timeoutMs)

		ws.onopen = () => {
			ws.send(payload)
		}

		ws.onmessage = async (event) => {
			const text = await websocketDataToString(event.data)
			finish(() => {
				try {
					resolve(JSON.parse(text) as Record<string, unknown>)
				} catch (error) {
					reject(
						new Error(
							`JellyFish controller returned invalid JSON: ${
								error instanceof Error ? error.message : String(error)
							}`,
						),
					)
				}
			})
		}

		ws.onerror = () => {
			finish(() => {
				reject(
					new Error(
						`JellyFish WebSocket connection failed for ${input.host}:${String(port)}.`,
					),
				)
			})
		}

		ws.onclose = (event) => {
			if (settled) return
			finish(() => {
				reject(
					new Error(
						`JellyFish WebSocket closed before a response was received (code ${event.code}) for ${input.host}:${String(port)}.`,
					),
				)
			})
		}
	})
}

export function identifyJellyfishController(input: {
	host: string
	port?: number
	response: Record<string, unknown>
}) {
	const hostname =
		(typeof input.response['hostName'] === 'string' &&
		input.response['hostName'].trim()
			? String(input.response['hostName']).trim()
			: null) ?? extractHostnameFromZones(input.response)
	if (!hostname) return null

	const name =
		(typeof input.response['ctlrName'] === 'string' &&
		input.response['ctlrName'].trim()
			? String(input.response['ctlrName']).trim()
			: hostname.replace(/\.local$/i, '')) || hostname

	return {
		controllerId: normalizeControllerId(hostname || input.host),
		name,
		hostname,
		host: input.host,
		port: input.port ?? jellyfishDefaultPort,
		firmwareVersion: extractFirmwareVersion(input.response),
		lastSeenAt: new Date().toISOString(),
		rawDiscovery: input.response,
	} satisfies JellyfishDiscoveredController
}

export async function probeJellyfishController(input: {
	host: string
	port?: number
	timeoutMs?: number
	mocksEnabled: boolean
}) {
	const response = await sendJellyfishCommand({
		host: input.host,
		port: input.port,
		command: {
			cmd: 'toCtlrGet',
			get: [['zones']],
		},
		timeoutMs: input.timeoutMs,
		mocksEnabled: input.mocksEnabled,
	})
	const controller = identifyJellyfishController({
		host: input.host,
		port: input.port,
		response,
	})
	if (!controller) {
		throw new Error(
			`Host ${input.host}:${String(input.port ?? jellyfishDefaultPort)} did not return a recognizable JellyFish zones payload.`,
		)
	}
	return {
		controller,
		response,
	}
}
