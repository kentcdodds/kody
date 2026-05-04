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
import {
	islandRouterCommandCatalog,
	type IslandRouterCommandRequest,
} from './types.ts'
import { renderIslandRouterCommand } from './command-catalog.ts'

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
			case 'show version':
				return createResult(
					request,
					['show version'],
					[
						'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
						'Copyright 2004-2026 PerfTech, Inc.',
					].join('\n'),
				)
			case 'show clock':
				return createResult(request, ['show clock'], '2026-05-04 13:20:00 PDT')
			case 'show interface summary':
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
			case 'show ip neighbors':
				return createResult(
					request,
					['show ip neighbors'],
					[
						'IP Address    MAC Address        Interface  State',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  en0        reachable',
					].join('\n'),
				)
			case 'show ip sockets':
				return createResult(
					request,
					['show ip sockets'],
					[
						'Protocol  Local Address         Foreign Address       State',
						'--------  --------------------  --------------------  -----------',
						'tcp       192.168.0.1:22       192.168.0.20:51514   established',
					].join('\n'),
				)
			case 'show stats':
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
			case 'show interface':
				return createResult(
					request,
					[`show interface ${String(request.params?.['interfaceName'])}`],
					[
						`Interface: ${String(request.params?.['interfaceName'])}`,
						'Link State: up',
						'Speed: 1G',
						'Duplex: full',
					].join('\n'),
				)
			case 'show ip interface':
				return createResult(
					request,
					[`show ip interface ${String(request.params?.['interfaceName'])}`],
					[
						`Interface: ${String(request.params?.['interfaceName'])}`,
						'Address: 192.168.0.1/24',
						'DHCP Server: enabled',
					].join('\n'),
				)
			case 'show log':
				return createResult(
					request,
					['show log'],
					[
						'2026/05/04-13:17:57.956 5 pe-dhcp: renewed lease for 192.168.0.52',
						'2026/05/04-13:17:58.001 4 pe-link: en1 carrier down',
					].join('\n'),
				)
			case 'show running-config':
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
			case 'show running-config differences':
				return createResult(
					request,
					['show running-config differences'],
					'No differences found.',
				)
			case 'show ip dhcp-reservations':
				return createResult(
					request,
					['show ip dhcp-reservations'],
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
			case 'show ip routes':
				return createResult(
					request,
					['show ip routes'],
					[
						'Destination      Gateway       Interface  Protocol  Metric  Selected',
						'---------------  ------------  ---------  --------  ------  --------',
						'default          203.0.113.1   en1        static    1       yes',
					].join('\n'),
				)
			case 'show ip recommendations':
				return createResult(
					request,
					['show ip recommendations'],
					'No IP recommendations at this time.',
				)
			case 'clear dhcp-client':
				return createResult(
					request,
					['clear dhcp-client'],
					'DHCP client renewal requested.',
				)
			case 'clear log':
				return createResult(request, ['clear log'], 'Log buffer cleared.')
			case 'write memory':
				return createResult(
					request,
					['write memory'],
					'Running configuration saved.',
				)
			case 'ip dhcp-reserve':
				return createResult(
					request,
					renderIslandRouterCommand({
						id: request.id,
						params: request.params,
					}).commandLines,
					'DHCP reservation added.',
				)
			case 'no ip dhcp-reserve':
				return createResult(
					request,
					renderIslandRouterCommand({
						id: request.id,
						params: request.params,
					}).commandLines,
					'DHCP reservation removed.',
				)
			case 'interface ip autoconfig':
			case 'interface description':
			case 'no interface description':
			case 'syslog server':
			case 'no syslog server':
			case 'ip port-forward':
				return createResult(
					request,
					renderIslandRouterCommand({
						id: request.id,
						params: request.params,
					}).commandLines,
					'Configuration updated.',
				)
			case 'show startup-config':
			case 'show interface transceivers':
			case 'show syslog':
			case 'show ntp':
			case 'show users':
			case 'show vpns':
			case 'show hardware':
			case 'show free-space':
			case 'show packages':
			case 'show dumps':
			case 'show public-key':
			case 'show ssh-client-keys':
			case 'show config authorized-keys':
			case 'show config known-hosts':
			case 'ping':
				return createResult(
					request,
					renderIslandRouterCommand({
						id: request.id,
						params: request.params,
					}).commandLines,
					`${request.id} output`,
				)
			default: {
				const _exhaustive: never = request.id
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

test('island router command catalog covers documented command metadata', () => {
	const catalogIds = islandRouterCommandCatalog.map((entry) => entry.id)
	expect(catalogIds).toEqual(new Set(catalogIds).size === catalogIds.length ? catalogIds : [])
	expect(catalogIds).toEqual(
		expect.arrayContaining([
			'show clock',
			'show version',
			'show running-config',
			'show startup-config',
			'show interface summary',
			'show interface',
			'show ip interface',
			'show ip dhcp-reservations',
			'show log',
			'ping',
			'clear dhcp-client',
			'clear log',
			'write memory',
			'ip dhcp-reserve',
			'no ip dhcp-reserve',
			'interface ip autoconfig',
			'interface description',
			'no interface description',
			'syslog server',
			'ip port-forward',
		]),
	)

	for (const entry of islandRouterCommandCatalog) {
		expect(entry.cliTemplate).not.toMatch(/\s{2,}/)
		expect(entry.blastRadius.length).toBeGreaterThan(0)
		expect(entry.operatorGuidance.length).toBeGreaterThan(0)
		if (entry.access === 'read') {
			expect(entry.riskLevel).toBe('read')
			expect(entry.persistence.requiresWriteMemory).toBe(false)
		} else {
			expect(entry.riskLevel).not.toBe('read')
		}
	}
})

test('island router command substrate renders documented read commands', async () => {
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
			commandId: 'show ip neighbors',
			expectedCommandLine: 'show ip neighbors',
		},
		{
			commandId: 'show ip sockets',
			expectedCommandLine: 'show ip sockets',
		},
		{
			commandId: 'show stats',
			expectedCommandLine: 'show stats',
		},
		{
			commandId: 'show interface',
			params: { interfaceName: 'en0' },
			expectedCommandLine: 'show interface en0',
		},
		{
			commandId: 'show ip interface',
			params: { interfaceName: 'en0' },
			expectedCommandLine: 'show ip interface en0',
		},
		{
			commandId: 'show log',
			query: 'lease',
			limit: 1,
			expectedCommandLine: 'show log',
		},
		{
			commandId: 'show running-config',
			expectedCommandLine: 'show running-config',
		},
		{
			commandId: 'show running-config differences',
			expectedCommandLine: 'show running-config differences',
		},
		{
			commandId: 'show ip dhcp-reservations',
			expectedCommandLine: 'show ip dhcp-reservations',
		},
		{
			commandId: 'show ip routes',
			expectedCommandLine: 'show ip routes',
		},
		{
			commandId: 'show ip recommendations',
			expectedCommandLine: 'show ip recommendations',
		},
	] as const

	for (const routerCommand of cases) {
		const result = await islandRouter.runCommand(routerCommand)
		expect(result.commandId).toBe(routerCommand.commandId)
		expect(result.commandLines).toContain(routerCommand.expectedCommandLine)
		expect(result.catalogEntry.id).toBe(routerCommand.commandId)
	}

	const logResult = await islandRouter.runCommand({
		commandId: 'show log',
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

test('island router command substrate rejects aliases, bad params, and injection attempts', async () => {
	using _env = withTemporaryEnv({})
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})

	await expect(
		islandRouter.runCommand({
			commandId: 'show-ip-arp' as never,
		}),
	).rejects.toThrow('Unsupported Island router command id')
	await expect(
		islandRouter.runCommand({
			commandId: 'show interface',
		}),
	).rejects.toThrow('interfaceName')
	await expect(
		islandRouter.runCommand({
			commandId: 'show ip neighbors',
			params: { query: '192.168.0.52' },
		}),
	).rejects.toThrow('does not accept parameter(s): query')
	await expect(
		islandRouter.runCommand({
			commandId: 'show ip routes',
			params: { interfaceName: 'en0' },
		}),
	).rejects.toThrow('does not accept parameter(s): interfaceName')
	await expect(
		islandRouter.runCommand({
			commandId: 'show interface',
			params: { interfaceName: 'en0; write memory' },
		}),
	).rejects.toThrow('single Island interface token')
	await expect(
		islandRouter.runCommand({
			commandId: 'ip dhcp-reserve',
			params: {
				ipAddress: '192.168.0.52 && reload',
				macAddress: '00:11:22:33:44:55',
			},
			reason:
				'The operator verified this DHCP reservation is needed for this exact MAC address.',
			confirmation: islandRouter.writeConfirmation,
		}),
	).rejects.toThrow('valid IPv4 address')
	await expect(
		islandRouter.runCommand({
			commandId: 'ip dhcp-reserve',
			params: {
				ipAddress: '192.168.0.52',
				macAddress: '00:11:22:33:44:55;reload',
			},
			reason:
				'The operator verified this DHCP reservation is needed for this exact MAC address.',
			confirmation: islandRouter.writeConfirmation,
		}),
	).rejects.toThrow('valid MAC address')
	await expect(
		islandRouter.runCommand({
			commandId: 'ping',
			params: { host: 'router.local;reload' },
		}),
	).rejects.toThrow('valid IP address or hostname')
	await expect(
		islandRouter.runCommand({
			commandId: 'ip port-forward',
			params: {
				protocol: 'tcp',
				publicPort: '70000',
				target: 'island',
				destinationPort: '443',
			},
			reason:
				'The operator verified this port-forward is required and safe for this target.',
			confirmation: islandRouter.writeConfirmation,
		}),
	).rejects.toThrow('between 1 and 65535')
	await expect(
		islandRouter.runCommand({
			commandId: 'interface ip autoconfig',
			params: { interfaceName: 'en0', mode: 'wan;reload' },
			reason:
				'The operator verified this interface mode change is required and safe.',
			confirmation: islandRouter.writeConfirmation,
		}),
	).rejects.toThrow('must be one of')
})

test('island router command substrate rejects incomplete SSH configuration', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	process.env.ISLAND_ROUTER_HOST = ''
	const islandRouter = createIslandRouterAdapter({
		config: loadHomeConnectorConfig(),
		commandRunner: createFakeRunner(),
	})

	await expect(
		islandRouter.runCommand({
			commandId: 'show ip neighbors',
		}),
	).rejects.toThrow('Island router SSH diagnostics are not configured')
})

test('island router write commands require verification, reason, and exact confirmation', async () => {
	using _env = withTemporaryEnv({})
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})
	const reason =
		'The operator verified this specific router mutation is required for recovery right now.'

	for (const commandId of [
		'clear dhcp-client',
		'clear log',
		'write memory',
	] as const) {
		const result = await islandRouter.runCommand({
			commandId,
			reason,
			confirmation: islandRouter.writeConfirmation,
		})
		expect(result.catalogEntry).toMatchObject({
			id: commandId,
			blastRadius: expect.any(String),
		})
		expect(result.catalogEntry.access).toBe('write')
		expect(result.commandLines).toContain(result.catalogEntry.cliTemplate)
	}

	createConfig()
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT = ''
	const unverifiedRouter = createIslandRouterAdapter({
		config: loadHomeConnectorConfig(),
		commandRunner: createFakeRunner(),
	})
	await expect(
		unverifiedRouter.runCommand({
			commandId: 'clear dhcp-client',
			reason,
			confirmation: unverifiedRouter.writeConfirmation,
		}),
	).rejects.toThrow('SSH host verification')

	const verifiedRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: createFakeRunner(),
	})
	await expect(
		verifiedRouter.runCommand({
			commandId: 'write memory',
			reason,
			confirmation: undefined,
		}),
	).rejects.toThrow('exact confirmation')
	await expect(
		verifiedRouter.runCommand({
			commandId: 'write memory',
			reason,
			confirmation: 'wrong',
		}),
	).rejects.toThrow('exact confirmation')
	await expect(
		verifiedRouter.runCommand({
			commandId: 'write memory',
			reason: 'too short',
			confirmation: verifiedRouter.writeConfirmation,
		}),
	).rejects.toThrow('specific operator reason')
})

test('island router write command rendering uses catalog contexts without automatic write memory', async () => {
	using _env = withTemporaryEnv({})
	const recordedRequests: Array<IslandRouterCommandRequest> = []
	const islandRouter = createIslandRouterAdapter({
		config: createConfig(),
		commandRunner: async (request) => {
			recordedRequests.push(request)
			return await createFakeRunner()(request)
		},
	})
	const reason =
		'The operator verified this exact catalog command and parameters are required.'

	const dhcpReservation = await islandRouter.runCommand({
		commandId: 'ip dhcp-reserve',
		params: {
			ipAddress: '192.168.0.52',
			macAddress: '00-11-22-33-44-55',
		},
		reason,
		confirmation: islandRouter.writeConfirmation,
	})
	expect(dhcpReservation.commandLines).toEqual([
		'terminal length 0',
		'configure terminal',
		'ip dhcp-reserve 192.168.0.52 00:11:22:33:44:55',
		'end',
	])
	expect(dhcpReservation.params).toEqual({
		ipAddress: '192.168.0.52',
		macAddress: '00:11:22:33:44:55',
	})
	expect(dhcpReservation.catalogEntry.persistence.requiresWriteMemory).toBe(true)
	expect(dhcpReservation.commandLines).not.toContain('write memory')

	const interfaceDescription = await islandRouter.runCommand({
		commandId: 'interface description',
		params: {
			interfaceName: 'en0',
			description: 'LAN uplink',
		},
		reason,
		confirmation: islandRouter.writeConfirmation,
	})
	expect(interfaceDescription.commandLines).toEqual([
		'terminal length 0',
		'configure terminal',
		'interface en0',
		'description "LAN uplink"',
		'end',
	])

	const portForward = await islandRouter.runCommand({
		commandId: 'ip port-forward',
		params: {
			protocol: 'tcp',
			publicPort: '8443',
			target: 'island',
			destinationPort: '443',
		},
		reason,
		confirmation: islandRouter.writeConfirmation,
	})
	expect(portForward.commandLines).toContain(
		'ip port-forward tcp 8443 island 443',
	)
	expect(recordedRequests.map((request) => request.id)).not.toContain(
		'renew-dhcp-clients' as never,
	)
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
