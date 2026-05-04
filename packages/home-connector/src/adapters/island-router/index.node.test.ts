import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createIslandRouterAdapter } from './index.ts'
import {
	parseIslandRouterDhcpServerConfig,
	parseIslandRouterDhcpReservations,
	parseIslandRouterInterfaceSummaries,
	parseIslandRouterRecentEvents,
	parseIslandRouterTrafficStats,
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
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	return loadHomeConnectorConfig()
}

function createResult(
	request: IslandRouterCommandRequest,
	commandLines: Array<string>,
	stdout: string,
) {
	return {
		id: request.id,
		commandLines: ['terminal length 0', ...commandLines],
		stdout,
		stderr: '',
		exitCode: 0,
		signal: null,
		timedOut: false,
		durationMs: 10,
	}
}

function createFakeRunner() {
	return async (request: IslandRouterCommandRequest) => {
		switch (request.id) {
			case 'show-version':
				return createResult(
					request,
					['show version'],
					[
						'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
						'Copyright 2004-2026 PerfTech, Inc.',
					].join('\n'),
				)
			case 'show-clock':
				return createResult(request, ['show clock'], '2026-05-04 13:20:00 PDT')
			case 'show-interface-summary':
				return createResult(
					request,
					['show interface summary'],
					[
						'Interface  Link   Speed  Duplex  Description',
						'---------  -----  -----  ------  -----------',
						'en0        up     1G     full    LAN uplink',
						'en1        down   2.5G   full    spare port',
					].join('\n'),
				)
			case 'show-ip-neighbors':
				return createResult(
					request,
					['show ip neighbors'],
					[
						'IP Address    MAC Address        Interface  State',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  en0        reachable',
					].join('\n'),
				)
			case 'show-ip-sockets':
				return createResult(
					request,
					['show ip sockets'],
					[
						'Protocol  Local Address         Foreign Address       State',
						'--------  --------------------  --------------------  -----------',
						'tcp       192.168.0.1:22       192.168.0.20:51514   established',
					].join('\n'),
				)
			case 'show-stats':
				return createResult(
					request,
					['show stats'],
					[
						'Uptime: 5 days 2 hours',
						'CPU Usage: 17%',
						'Memory Usage: 42%',
						'Interface  RX Bytes  TX Bytes  RX Packets  TX Packets  RX Errors  TX Errors  Utilization',
						'---------  --------  --------  ----------  ----------  ---------  ---------  -----------',
						'en0        1200000   2400000   1000        1500        0          1          37%',
					].join('\n'),
				)
			case 'show-interface':
				return createResult(
					request,
					[`show interface ${request.interfaceName}`],
					[
						`Interface: ${request.interfaceName}`,
						'Link State: up',
						'Speed: 1G',
						'Duplex: full',
					].join('\n'),
				)
			case 'show-ip-interface':
				return createResult(
					request,
					[`show ip interface ${request.interfaceName}`],
					[
						`Interface: ${request.interfaceName}`,
						'Address: 192.168.0.1/24',
						'DHCP Server: enabled',
					].join('\n'),
				)
			case 'show-log':
				return createResult(
					request,
					['show log'],
					[
						'2026/05/04-13:17:57.956 5 pe-dhcp: renewed lease for 192.168.0.52',
						'2026/05/04-13:17:58.001 4 pe-link: en1 carrier down',
					].join('\n'),
				)
			case 'show-running-config':
				return createResult(
					request,
					['show running-config'],
					[
						'ip dns mode recursive',
						'ip dns server 1.1.1.1',
						'interface en0',
						'ip address 192.168.0.1/24',
					].join('\n'),
				)
			case 'show-running-config-differences':
				return createResult(
					request,
					['show running-config differences'],
					'No differences found.',
				)
			case 'show-ip-dhcp':
				return createResult(
					request,
					['show ip dhcp'],
					[
						'IP Address    MAC Address        Host Name  Type',
						'------------  -----------------  ---------  -------',
						'192.168.0.88  aa:bb:cc:dd:ee:ff  laptop     dynamic',
						'',
						'Reservations',
						'IP Address    MAC Address        Host Name  Interface',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
					].join('\n'),
				)
			case 'show-ip-routes':
				return createResult(
					request,
					['show ip routes'],
					[
						'Destination      Gateway       Interface  Protocol  Metric  Selected',
						'---------------  ------------  ---------  --------  ------  --------',
						'default          203.0.113.1   en1        static    1       yes',
					].join('\n'),
				)
			case 'show-ip-recommendations':
				return createResult(
					request,
					['show ip recommendations'],
					'No IP recommendations at this time.',
				)
			case 'clear-dhcp-client':
				return createResult(
					request,
					['clear dhcp-client'],
					'DHCP client renewal requested.',
				)
			case 'clear-log':
				return createResult(request, ['clear log'], 'Log buffer cleared.')
			case 'write-memory':
				return createResult(
					request,
					['write memory'],
					'Running configuration saved.',
				)
			default: {
				const _exhaustive: never = request
				throw new Error(
					`Unhandled fake Island router request: ${String(_exhaustive)}`,
				)
			}
		}
	}
}

test('island router adapter returns status with parsed interface speed and duplex', async () => {
	using _env = withTemporaryEnv({})
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()

	expect(status.connected).toBe(true)
	expect(status.router.version).toMatchObject({
		model: 'Island Pro',
		serialNumber: '08008A020104',
		firmwareVersion: '3.2.3',
	})
	expect(status.interfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'en0',
				linkState: 'up',
				speed: '1G',
				duplex: 'full',
			}),
			expect.objectContaining({
				name: 'en1',
				linkState: 'down',
				speed: '2.5G',
				duplex: 'full',
			}),
		]),
	)
	expect(status.neighbors).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				ipAddress: '192.168.0.52',
				macAddress: '00:11:22:33:44:55',
				interfaceName: 'en0',
			}),
		]),
	)
})

test('island router read command substrate uses exact documented CLI command strings', async () => {
	using _env = withTemporaryEnv({})
	const recordedRequests: Array<IslandRouterCommandRequest> = []
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: async (request) => {
			recordedRequests.push(request)
			return await createFakeRunner()(request)
		},
	})

	const cases = [
		{
			command: 'show ip neighbors',
			expectedCommandId: 'show-ip-neighbors',
			expectedCommandLine: 'show ip neighbors',
		},
		{
			command: 'show ip sockets',
			expectedCommandId: 'show-ip-sockets',
			expectedCommandLine: 'show ip sockets',
		},
		{
			command: 'show stats',
			expectedCommandId: 'show-stats',
			expectedCommandLine: 'show stats',
		},
		{
			command: 'show interface <iface>',
			interfaceName: 'en0',
			expectedCommandId: 'show-interface',
			expectedCommandLine: 'show interface en0',
		},
		{
			command: 'show ip interface <iface>',
			interfaceName: 'en0',
			expectedCommandId: 'show-ip-interface',
			expectedCommandLine: 'show ip interface en0',
		},
		{
			command: 'show log',
			query: 'lease',
			limit: 1,
			expectedCommandId: 'show-log',
			expectedCommandLine: 'show log',
		},
		{
			command: 'show running-config',
			expectedCommandId: 'show-running-config',
			expectedCommandLine: 'show running-config',
		},
		{
			command: 'show running-config differences',
			expectedCommandId: 'show-running-config-differences',
			expectedCommandLine: 'show running-config differences',
		},
		{
			command: 'show ip dhcp',
			expectedCommandId: 'show-ip-dhcp',
			expectedCommandLine: 'show ip dhcp',
		},
		{
			command: 'show ip routes',
			expectedCommandId: 'show-ip-routes',
			expectedCommandLine: 'show ip routes',
		},
		{
			command: 'show ip recommendations',
			expectedCommandId: 'show-ip-recommendations',
			expectedCommandLine: 'show ip recommendations',
		},
	] as const

	for (const routerCommand of cases) {
		const result = await islandRouter.runReadCommand(routerCommand)
		expect(result.command).toBe(routerCommand.command)
		expect(result.commandId).toBe(routerCommand.expectedCommandId)
		expect(result.commandLines).toContain(routerCommand.expectedCommandLine)
		expect(result.catalogEntry.command).toBe(routerCommand.command)
	}

	const logResult = await islandRouter.runReadCommand({
		command: 'show log',
		query: 'carrier',
		limit: 1,
	})
	expect(logResult.lines).toEqual([
		'2026/05/04-13:17:58.001 4 pe-link: en1 carrier down',
	])
	expect(recordedRequests.map((request) => request.id)).not.toContain(
		'show-ip-arp',
	)
})

test('island router read command substrate rejects aliases and missing scoped params', async () => {
	using _env = withTemporaryEnv({})
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})

	await expect(
		islandRouter.runReadCommand({
			command: 'show-ip-arp' as never,
		}),
	).rejects.toThrow('Unsupported Island router read command')
	await expect(
		islandRouter.runReadCommand({
			command: 'show interface <iface>',
		}),
	).rejects.toThrow('interfaceName')
	await expect(
		islandRouter.runReadCommand({
			command: 'show ip neighbors',
			query: '192.168.0.52',
		}),
	).rejects.toThrow('does not accept parameter(s): query')
	await expect(
		islandRouter.runReadCommand({
			command: 'show ip routes',
			interfaceName: 'en0',
		}),
	).rejects.toThrow('does not accept parameter(s): interfaceName')
})

test('island router guarded write operations require verification and exact acknowledgement', async () => {
	using _env = withTemporaryEnv({})
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})
	const reason =
		'The operator verified this specific router mutation is required for recovery right now.'

	for (const operation of [
		'renew dhcp clients',
		'clear log buffer',
		'save running config',
	] as const) {
		const result = await islandRouter.runWriteOperation({
			operation,
			acknowledgeHighRisk: true,
			reason,
			confirmation: islandRouter.writeAcknowledgements.runWriteOperation,
		})
		expect(result.catalogEntry).toMatchObject({
			operation,
			riskLevel: 'high',
			blastRadius: expect.any(String),
		})
		expect(result.commandLines).toContain(result.catalogEntry.command)
	}

	createConfig()
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT = ''
	const unverifiedRouter = createIslandRouterAdapter({
		config: loadHomeConnectorConfig(),
		commandRunner: createFakeRunner(),
	})
	await expect(
		unverifiedRouter.runWriteOperation({
			operation: 'renew dhcp clients',
			acknowledgeHighRisk: true,
			reason,
			confirmation: unverifiedRouter.writeAcknowledgements.runWriteOperation,
		}),
	).rejects.toThrow('SSH host verification')

	const verifiedRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})
	await expect(
		verifiedRouter.runWriteOperation({
			operation: 'save running config',
			acknowledgeHighRisk: false,
			reason,
			confirmation: verifiedRouter.writeAcknowledgements.runWriteOperation,
		}),
	).rejects.toThrow('acknowledgeHighRisk=true')
	await expect(
		verifiedRouter.runWriteOperation({
			operation: 'save running config',
			acknowledgeHighRisk: true,
			reason: 'too short',
			confirmation: verifiedRouter.writeAcknowledgements.runWriteOperation,
		}),
	).rejects.toThrow('specific operator reason')
	await expect(
		verifiedRouter.runWriteOperation({
			operation: 'save running config',
			acknowledgeHighRisk: true,
			reason,
			confirmation: 'wrong',
		}),
	).rejects.toThrow('exact acknowledgement')
})

test('parsers handle documented Island command output shapes used by status and packages', () => {
	const summaries = parseIslandRouterInterfaceSummaries(
		['en0 up 1G full', 'en1 down 2.5G full'].join('\n'),
		['show interface summary'],
	)
	expect(summaries).toEqual([
		expect.objectContaining({
			name: 'en0',
			linkState: 'up',
			speed: '1G',
			duplex: 'full',
		}),
		expect.objectContaining({
			name: 'en1',
			linkState: 'down',
			speed: '2.5G',
			duplex: 'full',
		}),
	])

	const recentEvents = parseIslandRouterRecentEvents(
		'2026/05/04-13:17:57.956 5 pe-dhcp: renewed lease for 192.168.0.52',
		['show log'],
	)
	expect(recentEvents).toEqual([
		expect.objectContaining({
			timestamp: '2026/05/04-13:17:57.956',
			level: '5',
			module: 'pe-dhcp',
			message: 'pe-dhcp: renewed lease for 192.168.0.52',
		}),
	])

	const dhcpEntries = parseIslandRouterDhcpReservations(
		[
			'IP Address    MAC Address        Host Name  Interface',
			'------------  -----------------  ---------  ---------',
			'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
		].join('\n'),
		['show ip dhcp'],
	)
	expect(dhcpEntries).toEqual([
		expect.objectContaining({
			ipAddress: '192.168.0.52',
			macAddress: '00:11:22:33:44:55',
			hostName: 'nas-box',
			interfaceName: 'en0',
		}),
	])

	const dhcpServerConfig = parseIslandRouterDhcpServerConfig(
		[
			'ip dhcp-reserve 192.168.0.99 11:22:33:44:55:66',
			'interface en0',
			'ip address 192.168.0.1/24',
			'ip dhcp-server on',
			'IP Address    MAC Address        Host Name  Type',
			'------------  -----------------  ---------  -------',
			'192.168.0.88  aa:bb:cc:dd:ee:ff  laptop     dynamic',
			'',
			'Reservations',
			'IP Address    MAC Address        Host Name  Interface',
			'------------  -----------------  ---------  ---------',
			'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
		].join('\n'),
		['show running-config', 'show ip dhcp'],
	)
	expect(dhcpServerConfig.reservations).toEqual([
		expect.objectContaining({
			ipAddress: '192.168.0.52',
			macAddress: '00:11:22:33:44:55',
			hostName: 'nas-box',
			interfaceName: 'en0',
		}),
	])

	const trafficStats = parseIslandRouterTrafficStats(
		[
			'Interface  RX Bytes  TX Bytes  RX Packets  TX Packets  RX Errors  TX Errors  Utilization',
			'---------  --------  --------  ----------  ----------  ---------  ---------  -----------',
			'en0        1200000   2400000   1000        1500        0          1          37%',
		].join('\n'),
		['show stats'],
	)
	expect(trafficStats.interfaces).toEqual([
		expect.objectContaining({
			interfaceName: 'en0',
			rxBytes: 1_200_000,
			txBytes: 2_400_000,
			rxPackets: 1000,
			txPackets: 1500,
			rxErrors: 0,
			txErrors: 1,
			utilizationPercent: 37,
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
})
