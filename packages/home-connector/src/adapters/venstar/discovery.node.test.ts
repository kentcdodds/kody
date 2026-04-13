import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { expect, test, vi } from 'vitest'
import { createAppState } from '../../state.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { scanVenstarThermostats } from './discovery.ts'

async function createSsdpVenstarFixture() {
	const infoPayload = {
		name: 'Living Room Thermostat',
		mode: 3,
		state: 1,
		fan: 0,
		spacetemp: 72,
		heattemp: 68,
		cooltemp: 75,
		humidity: 40,
	}

	const httpServer = createServer((request, response) => {
		if (request.url === '/query/info') {
			response.writeHead(200, {
				'Content-Type': 'application/json',
			})
			response.end(JSON.stringify(infoPayload))
			return
		}

		response.writeHead(404)
		response.end('not found')
	})
	await new Promise<void>((resolve) => {
		httpServer.listen(0, '127.0.0.1', () => resolve())
	})
	const httpAddress = httpServer.address() as AddressInfo | null
	if (!httpAddress) {
		throw new Error('HTTP Venstar fixture failed to bind.')
	}

	const socket = createSocket('udp4')
	await new Promise<void>((resolve) => {
		socket.bind(0, '127.0.0.1', () => resolve())
	})

	socket.on('message', (message, remote) => {
		const request = message.toString()
		if (!request.includes('ST: venstar:thermostat:ecp')) {
			return
		}

		const response = [
			'HTTP/1.1 200 OK',
			`LOCATION: http://127.0.0.1:${httpAddress.port}/`,
			'USN: colortouch:ecp:00:23:a7:3a:b2:72:name:Living%20Room:type:residential',
			'ST: venstar:thermostat:ecp',
			'SERVER: MockVenstar/1.0',
			'',
			'',
		].join('\r\n')

		socket.send(Buffer.from(response), remote.port, remote.address)
	})

	const address = socket.address()
	const ssdpPort =
		typeof address === 'string'
			? Number.parseInt(address.split(':').at(-1) || '0', 10)
			: address.port

	return {
		discoveryUrl: `ssdp://127.0.0.1:${ssdpPort}?timeoutMs=200`,
		[Symbol.asyncDispose]: async () => {
			socket.close()
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			})
		},
	}
}

function createConfig(discoveryUrl: string): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		venstarDiscoveryUrl: discoveryUrl,
		venstarSubnetProbeCidrs: [],
		venstarThermostats: [],
		dataPath: '/tmp',
		dbPath: ':memory:',
		port: 4040,
		mocksEnabled: false,
	}
}

test('venstar SSDP discovery finds thermostat details and diagnostics', async () => {
	await using fixture = await createSsdpVenstarFixture()
	const state = createAppState()
	const config = createConfig(fixture.discoveryUrl)

	const result = await scanVenstarThermostats(state, config)

	expect(result.thermostats).toHaveLength(1)
	expect(result.thermostats[0]).toMatchObject({
		name: 'Living Room Thermostat',
		ip: expect.stringContaining('127.0.0.1:'),
		location: expect.stringContaining('http://127.0.0.1:'),
	})
	expect(result.diagnostics.protocol).toBe('ssdp')
	expect(result.diagnostics.ssdpHits).toHaveLength(1)
	expect(result.diagnostics.infoLookups).toHaveLength(1)
	expect(result.diagnostics.infoLookups[0]?.parsed).toMatchObject({
		name: 'Living Room Thermostat',
		spacetemp: 72,
		humidity: 40,
	})
	expect(state.venstarDiscoveredThermostats).toHaveLength(1)
	expect(state.venstarDiscoveryDiagnostics?.ssdpHits).toHaveLength(1)
})

test('venstar subnet probe discovers thermostats when SSDP finds nothing', async () => {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		if (url === 'http://10.0.0.88/query/info') {
			return new Response(
				JSON.stringify({
					name: 'Subnet fixture',
					mode: 1,
					state: 0,
					fan: 0,
					spacetemp: 70,
					heattemp: 68,
					cooltemp: 74,
					humidity: 35,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			)
		}
		return new Response('not found', { status: 404 })
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		const state = createAppState()
		const config = createConfig(
			'ssdp://127.0.0.1:49151?st=venstar:thermostat:ecp&timeoutMs=80',
		)
		config.venstarSubnetProbeCidrs = ['10.0.0.88/32']

		const result = await scanVenstarThermostats(state, config)

		expect(result.thermostats).toHaveLength(1)
		expect(result.thermostats[0]).toMatchObject({
			name: 'Subnet fixture',
			ip: '10.0.0.88',
		})
		expect(result.diagnostics.subnetProbe).toMatchObject({
			cidrs: ['10.0.0.88/32'],
			hostsProbed: 1,
			venstarMatches: 1,
		})
		expect(fetchMock).toHaveBeenCalled()
	} finally {
		globalThis.fetch = previousFetch
	}
})
