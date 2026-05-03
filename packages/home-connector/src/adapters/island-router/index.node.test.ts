import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createIslandRouterAdapter } from './index.ts'
import {
	parseIslandRouterDhcpReservations,
	parseIslandRouterInterfaceSummaries,
	parseIslandRouterNeighbors,
	parseIslandRouterRecentEvents,
	parseIslandRouterVersion,
	sanitizeIslandRouterOutput,
} from './parsing.ts'
import { type IslandRouterCommandRequest } from './types.ts'

function withTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]() {
			for (const [key, value] of Object.entries(previousValues)) {
				if (value === undefined) {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

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
	process.env.ISLAND_ROUTER_ENABLE_WRITE_OPERATIONS = 'false'
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
					commandLines: [
						'terminal length 0',
						`show interface ${request.interfaceName}`,
					],
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
			case 'clear-dhcp-client':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'clear dhcp-client'],
					stdout: 'DHCP client renewal requested.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'clear-log':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'clear log'],
					stdout: 'Log buffer cleared.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'write-memory':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'write memory'],
					stdout: 'Running configuration saved.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			default: {
				const _exhaustive: never = request
				throw new Error(
					`Unhandled fake Island router request: ${String(_exhaustive)}`,
				)
			}
		}
	}
}

test('island router adapter returns status and diagnoses a host from typed SSH output', async () => {
	using _env = withTemporaryEnv({})
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
	using _env = withTemporaryEnv({})
	createConfig()
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
	using _env = withTemporaryEnv({})
	createConfig()
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

test('island router adapter exposes write capability status and runs typed write operations only when explicitly enabled', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	process.env.ISLAND_ROUTER_ENABLE_WRITE_OPERATIONS = 'true'
	const config = loadHomeConnectorConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	expect(islandRouter.getConfigStatus()).toMatchObject({
		writeToolsEnabled: true,
		writeCapabilitiesAvailable: true,
	})

	const renewResult = await islandRouter.renewDhcpClients({
		acknowledgeHighRisk: true,
		reason:
			'The WAN DHCP lease is stale after an upstream change and must be renewed intentionally.',
		confirmation: islandRouter.writeAcknowledgements.renewDhcpClients,
	})
	expect(renewResult).toMatchObject({
		operationId: 'renew-dhcp-clients',
		commandId: 'clear-dhcp-client',
		commandLines: ['terminal length 0', 'clear dhcp-client'],
	})

	const clearLogResult = await islandRouter.clearLogBuffer({
		acknowledgeHighRisk: true,
		reason:
			'The current in-memory log spam was already collected and must be cleared before reproducing the issue.',
		confirmation: islandRouter.writeAcknowledgements.clearLogBuffer,
	})
	expect(clearLogResult).toMatchObject({
		operationId: 'clear-log-buffer',
		commandId: 'clear-log',
		commandLines: ['terminal length 0', 'clear log'],
	})

	const saveConfigResult = await islandRouter.saveRunningConfig({
		acknowledgeHighRisk: true,
		reason:
			'The intended network change was validated manually and now needs to be persisted across reboot.',
		confirmation: islandRouter.writeAcknowledgements.saveRunningConfig,
	})
	expect(saveConfigResult).toMatchObject({
		operationId: 'save-running-config',
		commandId: 'write-memory',
		commandLines: ['terminal length 0', 'write memory'],
	})
})

test('island router adapter rejects write operations without explicit enablement and exact confirmation', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	expect(islandRouter.getConfigStatus()).toMatchObject({
		writeToolsEnabled: false,
		writeCapabilitiesAvailable: false,
	})

	await expect(
		islandRouter.renewDhcpClients({
			acknowledgeHighRisk: true,
			reason:
				'The WAN DHCP lease is stale after an upstream change and must be renewed intentionally.',
			confirmation: islandRouter.writeAcknowledgements.renewDhcpClients,
		}),
	).rejects.toThrow('ISLAND_ROUTER_ENABLE_WRITE_OPERATIONS=true')

	process.env.ISLAND_ROUTER_ENABLE_WRITE_OPERATIONS = 'true'
	const enabledConfig = loadHomeConnectorConfig()
	const enabledIslandRouter = createIslandRouterAdapter({
		config: enabledConfig,
		commandRunner: createFakeRunner(),
	})

	await expect(
		enabledIslandRouter.saveRunningConfig({
			acknowledgeHighRisk: false,
			reason:
				'The intended network change was validated manually and now needs to be persisted across reboot.',
			confirmation: enabledIslandRouter.writeAcknowledgements.saveRunningConfig,
		}),
	).rejects.toThrow('acknowledgeHighRisk=true')
	await expect(
		enabledIslandRouter.saveRunningConfig({
			acknowledgeHighRisk: true,
			reason: 'too short',
			confirmation: enabledIslandRouter.writeAcknowledgements.saveRunningConfig,
		}),
	).rejects.toThrow('specific operator reason')
	await expect(
		enabledIslandRouter.saveRunningConfig({
			acknowledgeHighRisk: true,
			reason:
				'The intended network change was validated manually and now needs to be persisted across reboot.',
			confirmation: 'I think this is probably okay.',
		}),
	).rejects.toThrow('exact acknowledgement')
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

test('parser handles real Island CLI transcript shape with prompt echoes and goodbye', () => {
	const commandLines = ['terminal length 0', 'show version']
	const stdout = [
		'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
		'Copyright 2004-2026 PerfTech, Inc.',
		'',
		'Dodds-Island>show version',
		'',
		'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
		'Copyright 2004-2026 PerfTech, Inc.',
		'',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')

	expect(sanitizeIslandRouterOutput(stdout, commandLines)).toEqual([
		'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
		'Copyright 2004-2026 PerfTech, Inc.',
	])
	expect(parseIslandRouterVersion(stdout, commandLines)).toMatchObject({
		model: 'Island Pro',
		serialNumber: '08008A020104',
		firmwareVersion: '3.2.3',
		attributes: expect.arrayContaining([
			expect.objectContaining({
				key: 'Hardware Model',
				value: 'IL-0002-01',
			}),
		]),
	})
})

test('sanitizeIslandRouterOutput keeps legitimate lines that end with bracketed text', () => {
	const commandLines = ['terminal length 0', 'show version']
	const stdout = [
		'Dodds-Island>show version',
		'Firmware: v2.0 [beta]',
		'VLAN [100]',
		'Dodds-Island>',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')

	expect(sanitizeIslandRouterOutput(stdout, commandLines)).toEqual([
		'Firmware: v2.0 [beta]',
		'VLAN [100]',
	])
})

test('parser ignores prompt echoes for real neighbor, dhcp, and log transcripts', () => {
	const neighborsTranscript = [
		'Dodds-Island>show ip neighbors',
		'IP Address    MAC Address        Interface  State',
		'------------  -----------------  ---------  ---------',
		'192.168.0.52  00:11:22:33:44:55  en0        reachable',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')
	const dhcpTranscript = [
		'Dodds-Island>show ip dhcp-reservations',
		'IP Address    MAC Address        Host Name  Interface',
		'------------  -----------------  ---------  ---------',
		'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')
	const logTranscript = [
		'Dodds-Island>show log last where "192.168.0.52"',
		'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')

	expect(
		parseIslandRouterNeighbors(neighborsTranscript, [
			'terminal length 0',
			'show ip neighbors',
		]),
	).toEqual([
		expect.objectContaining({
			ipAddress: '192.168.0.52',
			macAddress: '00:11:22:33:44:55',
			interfaceName: 'en0',
			state: 'reachable',
		}),
	])
	expect(
		parseIslandRouterDhcpReservations(dhcpTranscript, [
			'terminal length 0',
			'show ip dhcp-reservations',
		]),
	).toEqual([
		expect.objectContaining({
			ipAddress: '192.168.0.52',
			macAddress: '00:11:22:33:44:55',
			hostName: 'nas-box',
			interfaceName: 'en0',
		}),
	])
	expect(
		parseIslandRouterRecentEvents(logTranscript, [
			'terminal length 0',
			'show log last where "192.168.0.52"',
		]),
	).toEqual([
		expect.objectContaining({
			timestamp: '2026-05-02 15:50:00',
			level: 'info',
			module: 'net',
		}),
	])
})

test('real CLI exit-code-1 transcripts remain successful when log output includes not-found text', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: async (request) => {
			switch (request.id) {
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
							request.query
								? `Dodds-Island>show log last where "${request.query.replaceAll('"', '\\"')}"`
								: 'Dodds-Island>show log last',
							'2026-05-02 15:50:00 warning arp: ARP entry not found for 192.168.0.52',
							'2026-05-02 15:50:01 err net: TCP connection timed out while probing uplink',
							'Dodds-Island>exit',
							'Goodbye',
						].join('\n'),
						stderr: '',
						exitCode: 1,
						signal: null,
						timedOut: false,
						durationMs: 10,
					}
				default:
					return await createFakeRunner()(request)
			}
		},
	})

	const recentEvents = await islandRouter.getRecentEvents({
		host: '192.168.0.52',
	})

	expect(recentEvents).toEqual([
		expect.objectContaining({
			level: 'warning',
			module: 'arp',
			message: 'warning arp: ARP entry not found for 192.168.0.52',
		}),
		expect.objectContaining({
			level: 'err',
			module: 'net',
			message: 'err net: TCP connection timed out while probing uplink',
		}),
	])
})

test('island router adapter accepts real CLI transcripts that exit with code 1', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const realCliExitOneRunner = async (request: IslandRouterCommandRequest) => {
		switch (request.id) {
			case 'show-version':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show version'],
					stdout: [
						'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
						'Copyright 2004-2026 PerfTech, Inc.',
						'',
						'Dodds-Island>show version',
						'',
						'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
						'Copyright 2004-2026 PerfTech, Inc.',
						'',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-clock':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show clock'],
					stdout: [
						'Dodds-Island>show clock',
						'2026-05-02 15:55:00 PDT',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-interface-summary':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show interface summary'],
					stdout: [
						'Dodds-Island>show interface summary',
						'Interface  Link   Speed  Duplex  Description',
						'---------  -----  -----  ------  -----------',
						'en0        up     1G     full    LAN uplink',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-neighbors':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip neighbors'],
					stdout: [
						'Dodds-Island>show ip neighbors',
						'IP Address    MAC Address        Interface  State',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  en0        reachable',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-dhcp-reservations':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip dhcp-reservations'],
					stdout: [
						'Dodds-Island>show ip dhcp-reservations',
						'IP Address    MAC Address        Host Name  Interface',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
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
						request.query
							? `Dodds-Island>show log last where "${request.query.replaceAll('"', '\\"')}"`
							: 'Dodds-Island>show log last',
						'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-interface':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`show interface ${request.interfaceName}`,
					],
					stdout: [
						`Dodds-Island>show interface ${request.interfaceName}`,
						`Interface: ${request.interfaceName}`,
						'Link State: up',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
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
						`Dodds-Island>show ip interface ${request.interfaceName}`,
						`Interface: ${request.interfaceName}`,
						'Address: 192.168.0.1/24',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'ping':
				return {
					id: request.id,
					commandLines: ['terminal length 0', `ping ${request.host}`],
					stdout: [
						`Dodds-Island>ping ${request.host}`,
						'64 bytes from 192.168.0.52: icmp_seq=1 ttl=64 time=1.23 ms',
						'1 packets transmitted, 1 packets received, 0% packet loss',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 200,
				}
			default: {
				const _exhaustive: never = request
				throw new Error(
					`Unhandled fake Island router request: ${String(_exhaustive)}`,
				)
			}
		}
	}
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: realCliExitOneRunner,
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(true)
	expect(status.router.version).toMatchObject({
		model: 'Island Pro',
		serialNumber: '08008A020104',
		firmwareVersion: '3.2.3',
	})

	const dhcpLease = await islandRouter.getDhcpLease({
		host: 'nas-box',
	})
	expect(dhcpLease.lease).toMatchObject({
		hostName: 'nas-box',
		ipAddress: '192.168.0.52',
	})

	const recentEvents = await islandRouter.getRecentEvents({
		host: '192.168.0.52',
	})
	expect(recentEvents).toEqual([
		expect.objectContaining({
			module: 'net',
			level: 'info',
		}),
	])
})

test('island router adapter forwards explicit timeoutMs to ARP and DHCP lookups', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	const config = createConfig()
	const recordedTimeouts: Array<number | undefined> = []
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: async (request) => {
			recordedTimeouts.push(request.timeoutMs)
			return await createFakeRunner()(request)
		},
	})

	await islandRouter.getArpEntry({
		host: '192.168.0.52',
		timeoutMs: 12_345,
	})
	await islandRouter.getDhcpLease({
		host: '192.168.0.52',
		timeoutMs: 23_456,
	})

	expect(recordedTimeouts).toContain(12_345)
	expect(recordedTimeouts).toContain(23_456)
})

test('island router adapter rejects null exit codes for lookup helpers', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const nullExitRunner = async (request: IslandRouterCommandRequest) => ({
		id: request.id,
		commandLines: [
			'terminal length 0',
			request.id === 'show-log' ? 'show log last' : 'show ip neighbors',
		],
		stdout: '',
		stderr: 'signal terminated',
		exitCode: null,
		signal: 'SIGTERM' as const,
		timedOut: false,
		durationMs: 10,
	})
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: nullExitRunner,
	})

	await expect(
		islandRouter.getArpEntry({
			host: '192.168.0.52',
		}),
	).rejects.toThrow('signal terminated')
	await expect(
		islandRouter.getDhcpLease({
			host: '192.168.0.52',
		}),
	).rejects.toThrow('signal terminated')
	await expect(
		islandRouter.getRecentEvents({
			host: '192.168.0.52',
		}),
	).rejects.toThrow('signal terminated')
})
