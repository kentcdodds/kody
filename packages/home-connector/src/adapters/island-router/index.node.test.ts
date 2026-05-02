import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createIslandRouterAdapter } from './index.ts'
import { parseIslandRouterInterfaceSummaries } from './parsing.ts'
import { type IslandRouterCommandRequest } from './types.ts'

function createConfig() {
	process.env.MOCKS = 'false'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	process.env.ISLAND_ROUTER_HOST = 'router.local'
	process.env.ISLAND_ROUTER_PORT = '22'
	process.env.ISLAND_ROUTER_USERNAME = 'user'
	process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH = '/keys/id_ed25519'
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT =
		'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12'
	process.env.ISLAND_ROUTER_COMMAND_TIMEOUT_MS = '5000'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	return loadHomeConnectorConfig()
}

function createFakeRunner() {
	return async (request: IslandRouterCommandRequest) => {
		switch (request.id) {
			case 'show-version':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show version'],
					stdout: [
						'Model: Island Pro',
						'Serial Number: IR-12345',
						'Firmware Version: 2.3.2',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-clock':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show clock'],
					stdout: '2026-05-02 15:55:00 PDT',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-interface-summary':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show interface summary'],
					stdout: [
						'Interface  Link   Speed  Duplex  Description',
						'---------  -----  -----  ------  -----------',
						'en0        up     1G     full    LAN uplink',
						'en1        down   1G     full    spare port',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-neighbors':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip neighbors'],
					stdout: [
						'IP Address    MAC Address        Interface  State',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  en0        reachable',
						'192.168.0.1   aa:bb:cc:dd:ee:ff  en0        reachable',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-dhcp-reservations':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip dhcp-reservations'],
					stdout: [
						'IP Address    MAC Address        Host Name  Interface',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-log':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.query
							? `show log last where "${request.query.replaceAll('"', '\\"')}"`
							: 'show log last',
					],
					stdout: [
						'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
						'2026-05-02 15:50:10 warning dhcp: renewed lease for 192.168.0.52 00:11:22:33:44:55',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-interface':
				return {
					id: request.id,
					commandLines: ['terminal length 0', `show interface ${request.interfaceName}`],
					stdout: [
						`Interface: ${request.interfaceName}`,
						'Link State: up',
						'Speed: 1G',
						'Duplex: full',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-interface':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`show ip interface ${request.interfaceName}`,
					],
					stdout: [
						`Interface: ${request.interfaceName}`,
						'Address: 192.168.0.1/24',
						'DHCP Server: enabled',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'ping':
				return {
					id: request.id,
					commandLines: ['terminal length 0', `ping ${request.host}`],
					stdout: [
						'64 bytes from 192.168.0.52: icmp_seq=1 ttl=64 time=1.23 ms',
						'64 bytes from 192.168.0.52: icmp_seq=2 ttl=64 time=1.17 ms',
						'2 packets transmitted, 2 packets received, 0% packet loss',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 200,
				}
			default: {
				const _exhaustive: never = request
				throw new Error(`Unhandled fake Island router request: ${String(_exhaustive)}`)
			}
		}
	}
}

test('island router adapter returns status and diagnoses a host from typed SSH output', async () => {
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(true)
	expect(status.router.version).toMatchObject({
		model: 'Island Pro',
		serialNumber: 'IR-12345',
		firmwareVersion: '2.3.2',
	})
	expect(status.interfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'en0',
				linkState: 'up',
			}),
		]),
	)

	const diagnosis = await islandRouter.diagnoseHost({
		host: '192.168.0.52',
		logLimit: 5,
	})
	expect(diagnosis.ping).toMatchObject({
		reachable: true,
		transmitted: 2,
		received: 2,
		packetLossPercent: 0,
	})
	expect(diagnosis.arpEntry).toMatchObject({
		ipAddress: '192.168.0.52',
		macAddress: '00:11:22:33:44:55',
		interfaceName: 'en0',
	})
	expect(diagnosis.dhcpLease).toMatchObject({
		ipAddress: '192.168.0.52',
		macAddress: '00:11:22:33:44:55',
		hostName: 'nas-box',
	})
	expect(diagnosis.interfaceSummary).toMatchObject({
		name: 'en0',
		linkState: 'up',
	})
	expect(diagnosis.interfaceDetails?.attributes).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'Link State',
				value: 'up',
			}),
		]),
	)
	expect(diagnosis.recentEvents).toHaveLength(2)
	expect(diagnosis.errors).toEqual([])
})

test('island router adapter reports incomplete configuration without opening SSH', async () => {
	process.env.ISLAND_ROUTER_HOST = ''
	process.env.ISLAND_ROUTER_USERNAME = ''
	process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH = ''
	const config = loadHomeConnectorConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(false)
	expect(status.config.configured).toBe(false)
	expect(status.errors[0]).toContain('ISLAND_ROUTER_HOST')
})

test('island router adapter marks malformed fingerprint config as not configured', async () => {
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT = 'not-a-fingerprint'
	const config = loadHomeConnectorConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(false)
	expect(status.config.configured).toBe(false)
	expect(status.config.warnings).toEqual(
		expect.arrayContaining([
			expect.stringContaining('ISLAND_ROUTER_HOST_FINGERPRINT'),
		]),
	)
})

test('fallback interface summary parsing recognizes up and down link states', () => {
	const summaries = parseIslandRouterInterfaceSummaries(
		['en0 up 1G full', 'en1 down 1G full'].join('\n'),
		['show interface summary'],
	)

	expect(summaries).toEqual([
		expect.objectContaining({
			name: 'en0',
			linkState: 'up',
		}),
		expect.objectContaining({
			name: 'en1',
			linkState: 'down',
		}),
	])
})
