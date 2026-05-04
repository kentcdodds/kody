import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../mocks/test-server.ts'
import { createAccessNetworksUnleashedAdapter } from '../adapters/access-networks-unleashed/index.ts'
import { type AccessNetworksUnleashedClient } from '../adapters/access-networks-unleashed/types.ts'
import { createBondAdapter } from '../adapters/bond/index.ts'
import { renderIslandRouterCommand } from '../adapters/island-router/command-catalog.ts'
import { type IslandRouterCommandRequest } from '../adapters/island-router/types.ts'
import { createIslandRouterAdapter } from '../adapters/island-router/index.ts'
import { createJellyfishAdapter } from '../adapters/jellyfish/index.ts'
import { createLutronAdapter } from '../adapters/lutron/index.ts'
import { createSonosAdapter } from '../adapters/sonos/index.ts'
import { createSamsungTvAdapter } from '../adapters/samsung-tv/index.ts'
import { createVenstarAdapter } from '../adapters/venstar/index.ts'
import { upsertVenstarThermostat } from '../adapters/venstar/repository.ts'
import { loadHomeConnectorConfig } from '../config.ts'
import { createHomeConnectorMcpServer } from './server.ts'
import { createAppState } from '../state.ts'
import { createHomeConnectorStorage } from '../storage/index.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.LUTRON_DISCOVERY_URL = 'http://lutron.mock.local/discovery'
	process.env.SONOS_DISCOVERY_URL = 'http://sonos.mock.local/discovery'
	process.env.SAMSUNG_TV_DISCOVERY_URL =
		'http://samsung-tv.mock.local/discovery'
	process.env.BOND_DISCOVERY_URL = 'http://bond.mock.local/discovery'
	process.env.JELLYFISH_DISCOVERY_URL = 'http://jellyfish.mock.local/discovery'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32,192.168.10.41/32'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	process.env.ISLAND_ROUTER_HOST = 'router.local'
	process.env.ISLAND_ROUTER_PORT = '22'
	process.env.ISLAND_ROUTER_USERNAME = 'user'
	process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH = '/keys/id_ed25519'
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT =
		'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12'
	process.env.ISLAND_ROUTER_COMMAND_TIMEOUT_MS = '5000'
	process.env.ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS = '192.168.10.88/32'
	return loadHomeConnectorConfig()
}

function createIslandRouterRunner() {
	const createResult = (
		request: IslandRouterCommandRequest,
		commandLines: Array<string>,
		stdout: string,
	) => ({
		id: request.id,
		commandLines: ['terminal length 0', ...commandLines],
		stdout,
		stderr: '',
		exitCode: 0,
		signal: null,
		timedOut: false,
		durationMs: 10,
	})

	return async (request: IslandRouterCommandRequest) => {
		switch (request.id) {
			case 'show version':
				return createResult(
					request,
					['show version'],
					[
						'Model: Island Pro',
						'Serial Number: IR-12345',
						'Firmware Version: 2.3.2',
					].join('\n'),
				)
			case 'show clock':
				return createResult(request, ['show clock'], '2026-05-02 15:55:00 PDT')
			case 'show interface summary':
				return createResult(
					request,
					['show interface summary'],
					[
						'Interface  Link   Speed  Duplex  Description',
						'---------  -----  -----  ------  -----------',
						'en0        up     1G     full    LAN uplink',
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
						'Protocol  Local Address        Foreign Address       State',
						'--------  -------------------  --------------------  -----------',
						'tcp       192.168.0.1:22      192.168.0.20:51514   established',
					].join('\n'),
				)
			case 'show stats':
				return createResult(
					request,
					['show stats'],
					[
						'Uptime: 4 days 03 hours',
						'CPU Usage: 17%',
						'Memory Usage: 41%',
						'Interface  RX Bytes  TX Bytes  RX Packets  TX Packets  RX Errors  TX Errors  Utilization',
						'---------  --------  --------  ----------  ----------  ---------  ---------  -----------',
						'en0        1200000   2400000   1000        1500        0          1          37%',
					].join('\n'),
				)
			case 'show interface':
				return createResult(
					request,
					['show interface ' + String(request.params?.['interfaceName'])],
					[
						'Interface: ' + String(request.params?.['interfaceName']),
						'Link State: up',
						'Speed: 1G',
					].join('\n'),
				)
			case 'show ip interface':
				return createResult(
					request,
					['show ip interface ' + String(request.params?.['interfaceName'])],
					[
						'Interface: ' + String(request.params?.['interfaceName']),
						'Address: 192.168.0.1/24',
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
						'Destination      Gateway       Interface  Protocol  Metric',
						'---------------  ------------  ---------  --------  ------',
						'default          203.0.113.1   en1        static    1',
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
			case 'no ip dhcp-reserve':
			case 'interface ip autoconfig':
			case 'interface description':
			case 'no interface description':
			case 'syslog server':
			case 'no syslog server':
			case 'ip port-forward':
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
		}
	}
}

function createFakeAccessNetworksUnleashedClient() {
	const calls: Array<{
		action: string
		comp: string
		xmlBody: string
		updater?: string
	}> = []
	const client: AccessNetworksUnleashedClient = {
		async request(input) {
			calls.push({
				action: input.action,
				comp: input.comp,
				xmlBody: input.xmlBody,
				updater: input.updater,
			})
			const xml =
				'<ajax-response><system name="Access Networks Unleashed" version="200.15.6.212"/></ajax-response>'
			return {
				action: input.action,
				comp: input.comp,
				updater: input.updater ?? 'fake-updater',
				xml,
				parsed: {
					'ajax-response': {
						system: {
							'@name': 'Access Networks Unleashed',
							'@version': '200.15.6.212',
						},
					},
				},
			}
		},
	}
	return { client, calls }
}

function createAccessNetworksUnleashedFixture(input: {
	config: ReturnType<typeof loadHomeConnectorConfig>
	state: ReturnType<typeof createAppState>
	storage: ReturnType<typeof createHomeConnectorStorage>
}) {
	const fakeClient = createFakeAccessNetworksUnleashedClient()
	const scannedControllers = [
		{
			controllerId: 'unleashed-1',
			name: 'Access Networks Unleashed',
			host: '192.168.10.88',
			loginUrl: 'https://192.168.10.88/admin/wsg/login.jsp',
			lastSeenAt: '2026-05-03T19:00:00.000Z',
			rawDiscovery: {
				probeUrl: 'https://192.168.10.88/',
			},
		},
	]
	const accessNetworksUnleashed = createAccessNetworksUnleashedAdapter({
		config: input.config,
		state: input.state,
		storage: input.storage,
		clientFactory: () => fakeClient.client,
		scanControllers: async () => ({
			controllers: scannedControllers,
			diagnostics: {
				protocol: 'subnet',
				discoveryUrl: input.config.accessNetworksUnleashedScanCidrs.join(', '),
				scannedAt: '2026-05-03T19:00:00.000Z',
				probes: [
					{
						host: '192.168.10.88',
						url: 'https://192.168.10.88/',
						matched: true,
						status: 302,
						location: '/admin/wsg/login.jsp',
						matchReason: 'redirect',
						error: null,
						bodySnippet: null,
					},
				],
				subnetProbe: {
					cidrs: input.config.accessNetworksUnleashedScanCidrs,
					hostsProbed: 1,
					controllerMatches: 1,
				},
			},
		}),
	})
	return {
		accessNetworksUnleashed,
		fakeClient,
	}
}

installHomeConnectorMockServer()

test('mcp server exposes Samsung tools and executes samsung_list_devices', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	upsertVenstarThermostat({
		storage,
		connectorId: config.homeConnectorId,
		name: 'Hallway',
		ip: '192.168.10.40',
	})
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})
	const lutron = createLutronAdapter({
		config,
		state,
		storage,
	})
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createIslandRouterRunner(),
	})
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})
	const venstar = createVenstarAdapter({ config, state, storage })
	const { accessNetworksUnleashed, fakeClient: fakeAccessNetworksUnleashed } =
		createAccessNetworksUnleashedFixture({
			config,
			state,
			storage,
		})
	await samsungTv.scan()
	await lutron.scan()
	await sonos.scan()
	await bond.scan()
	await accessNetworksUnleashed.scan()
	const accessNetworksController =
		accessNetworksUnleashed.listControllers()[0]?.controllerId
	if (!accessNetworksController) {
		throw new Error(
			'Expected a discovered Access Networks Unleashed controller',
		)
	}
	accessNetworksUnleashed.adoptController({
		controllerId: accessNetworksController,
	})
	accessNetworksUnleashed.setCredentials({
		controllerId: accessNetworksController,
		username: 'admin',
		password: 'password',
	})
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
		samsungTv,
		lutron,
		sonos,
		bond,
		islandRouter,
		jellyfish,
		venstar,
		accessNetworksUnleashed,
	})

	try {
		const tools = mcp.listTools()
		expect(tools.some((tool) => tool.name === 'samsung_list_devices')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'samsung_set_art_mode')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'samsung_power_off')).toBe(true)
		expect(tools.some((tool) => tool.name === 'samsung_power_on')).toBe(true)
		expect(tools.some((tool) => tool.name === 'lutron_list_processors')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'lutron_get_inventory')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'sonos_list_players')).toBe(true)
		expect(tools.some((tool) => tool.name === 'sonos_play_favorite')).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'sonos_search_local_library'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'bond_list_bridges')).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'bond_authentication_guide'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'bond_prune_discovered_bridges'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'bond_list_groups')).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'bond_invoke_device_action'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_status')).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_run_command')).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_run_read_command')).toBe(
			false,
		)
		expect(
			tools.some((tool) => tool.name === 'router_run_write_operation'),
		).toBe(false)
		expect(tools.some((tool) => tool.name === 'router_ping_host')).toBe(false)
		expect(tools.some((tool) => tool.name === 'router_get_wan_config')).toBe(
			false,
		)
		expect(
			tools.some((tool) => tool.name === 'router_run_allowlisted_cli_command'),
		).toBe(false)
		expect(
			tools.some((tool) => tool.name === 'router_renew_dhcp_clients'),
		).toBe(false)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_scan_controllers',
			),
		).toBe(true)
		const accessNetworksScanTool = tools.find(
			(tool) => tool.name === 'access_networks_unleashed_scan_controllers',
		)
		expect(
			accessNetworksScanTool?.annotations?.['readOnlyHint'],
		).toBeUndefined()
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_set_credentials',
			),
		).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_request',
			),
		).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_list_controllers',
			),
		).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_authenticate_controller',
			),
		).toBe(true)
		const removedToolNames = [
			'access_networks_unleashed_get_status',
			'access_networks_unleashed_block_client',
			'access_networks_unleashed_unblock_client',
			'access_networks_unleashed_list_access_points',
			'access_networks_unleashed_list_clients',
			'access_networks_unleashed_list_wlans',
			'access_networks_unleashed_list_events',
			'access_networks_unleashed_list_blocked_clients',
			'access_networks_unleashed_get_alarms',
			'access_networks_unleashed_get_mesh_info',
			'access_networks_unleashed_get_syslog',
			'access_networks_unleashed_delete_wlan',
			'access_networks_unleashed_add_wlan',
			'access_networks_unleashed_hide_ap_leds',
			'access_networks_unleashed_show_ap_leds',
			'access_networks_unleashed_set_wlan_password',
			'access_networks_unleashed_restart_access_point',
			'access_networks_unleashed_clone_wlan',
			'access_networks_unleashed_edit_wlan',
		]
		for (const name of removedToolNames) {
			expect(tools.some((tool) => tool.name === name)).toBe(false)
		}
		expect(
			tools.some((tool) => tool.name === 'jellyfish_scan_controllers'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'jellyfish_list_zones')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'jellyfish_list_patterns')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'jellyfish_get_pattern')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'jellyfish_run_pattern')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'venstar_scan_thermostats')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'venstar_add_thermostat')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'venstar_remove_thermostat'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'venstar_get_thermostat_info'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'venstar_control_thermostat'),
		).toBe(true)
		const bondAuthGuide = await mcp.callTool('bond_authentication_guide')
		expect(bondAuthGuide.content[0]?.type).toBe('text')
		expect(bondAuthGuide.structuredContent).toMatchObject({
			adminPort: 4040,
			statusPath: '/bond/status',
			setupPath: '/bond/setup',
			bondLocalApiDocsUrl: 'https://docs-local.appbond.com/',
		})
		const lutronCredentialsTool = tools.find(
			(tool) => tool.name === 'lutron_set_credentials',
		)
		expect(lutronCredentialsTool).toBeDefined()
		if (!lutronCredentialsTool) {
			throw new Error('Expected lutron_set_credentials tool to be defined')
		}
		const lutronCredentialProperties = (
			lutronCredentialsTool.inputSchema as {
				properties?: Record<string, Record<string, unknown>>
			}
		).properties
		expect(lutronCredentialProperties?.username?.['x-kody-secret']).toBe(true)
		expect(lutronCredentialProperties?.password?.['x-kody-secret']).toBe(true)
		const accessNetworksCredentialsTool = tools.find(
			(tool) => tool.name === 'access_networks_unleashed_set_credentials',
		)
		if (!accessNetworksCredentialsTool) {
			throw new Error(
				'Expected access_networks_unleashed_set_credentials tool to be defined',
			)
		}
		const accessNetworksCredentialProperties = (
			accessNetworksCredentialsTool.inputSchema as {
				properties?: Record<string, Record<string, unknown>>
			}
		).properties
		expect(
			accessNetworksCredentialProperties?.username?.['x-kody-secret'],
		).toBe(true)
		expect(
			accessNetworksCredentialProperties?.password?.['x-kody-secret'],
		).toBe(true)

		const result = await mcp.callTool('samsung_list_devices')
		expect(result.structuredContent).toMatchObject({
			devices: expect.any(Array),
		})

		const lutronProcessors = await mcp.callTool('lutron_list_processors')
		expect(lutronProcessors.structuredContent).toMatchObject({
			processors: expect.any(Array),
		})
		const missingLutronProcessor = await mcp.callTool('lutron_get_inventory', {
			processorId: '',
		})
		expect(missingLutronProcessor.isError).toBe(true)
		expect(missingLutronProcessor.structuredContent).toEqual({
			error: {
				code: 'lutron_processor_not_found',
				message: 'Lutron processor "" was not found.',
				processorId: '',
			},
		})

		const sonosPlayers = await mcp.callTool('sonos_list_players')
		expect(sonosPlayers.structuredContent).toMatchObject({
			players: expect.any(Array),
		})

		const jellyfishScan = await mcp.callTool('jellyfish_scan_controllers')
		expect(jellyfishScan.structuredContent).toMatchObject({
			controllers: expect.any(Array),
			diagnostics: expect.anything(),
		})
		const jellyfishZones = await mcp.callTool('jellyfish_list_zones')
		expect(jellyfishZones.structuredContent).toMatchObject({
			controller: {
				hostname: 'JellyFish-F348.local',
			},
			zones: [
				{
					name: 'Zone',
				},
			],
		})
		const jellyfishPatterns = await mcp.callTool('jellyfish_list_patterns')
		expect(jellyfishPatterns.structuredContent).toMatchObject({
			patterns: expect.arrayContaining([
				expect.objectContaining({
					path: 'Christmas/Christmas Tree',
				}),
			]),
		})
		const jellyfishPattern = await mcp.callTool('jellyfish_get_pattern', {
			patternPath: 'Colors/Blue',
		})
		expect(jellyfishPattern.structuredContent).toMatchObject({
			pattern: {
				path: 'Colors/Blue',
				data: {
					type: 'Color',
				},
			},
		})
		const jellyfishRunPattern = await mcp.callTool('jellyfish_run_pattern', {
			patternPath: 'Christmas/Christmas Tree',
		})
		expect(jellyfishRunPattern.structuredContent).toMatchObject({
			controller: {
				hostname: 'JellyFish-F348.local',
			},
			zoneNames: ['Zone'],
			runPattern: {
				file: 'Christmas/Christmas Tree',
				state: 1,
				zoneName: ['Zone'],
			},
		})

		const venstarThermostats = await mcp.callTool('venstar_list_thermostats')
		expect(venstarThermostats.structuredContent).toMatchObject({
			thermostats: expect.any(Array),
		})
		const venstarScan = await mcp.callTool('venstar_scan_thermostats')
		expect(venstarScan.structuredContent).toMatchObject({
			discovered: expect.any(Array),
			diagnostics: expect.anything(),
		})
		const addedVenstar = await mcp.callTool('venstar_add_thermostat', {
			ip: '192.168.10.41',
		})
		expect(addedVenstar.structuredContent).toMatchObject({
			thermostat: {
				name: 'Office',
				ip: '192.168.10.41',
			},
		})
		const removedVenstar = await mcp.callTool('venstar_remove_thermostat', {
			ip: '192.168.10.41',
		})
		expect(removedVenstar.structuredContent).toMatchObject({
			thermostat: {
				name: 'Office',
				ip: '192.168.10.41',
			},
		})

		const accessNetworksScan = await mcp.callTool(
			'access_networks_unleashed_scan_controllers',
		)
		expect(accessNetworksScan.structuredContent).toMatchObject({
			controllers: expect.any(Array),
			diagnostics: expect.anything(),
		})
		const accessNetworksControllers = await mcp.callTool(
			'access_networks_unleashed_list_controllers',
		)
		expect(accessNetworksControllers.structuredContent).toMatchObject({
			controllers: expect.arrayContaining([
				expect.objectContaining({
					controllerId: 'unleashed-1',
					adopted: true,
					hasStoredCredentials: true,
				}),
			]),
		})

		const accessNetworksReadResult = await mcp.callTool(
			'access_networks_unleashed_request',
			{
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason:
					'Operator needs raw AJAX status read to verify the controller is reachable.',
				confirmation: accessNetworksUnleashed.requestConfirmation,
			},
		)
		expect(accessNetworksReadResult.structuredContent).toMatchObject({
			action: 'getstat',
			comp: 'system',
			xml: expect.stringContaining('Access Networks Unleashed'),
			parsed: {
				'ajax-response': {
					system: { '@name': 'Access Networks Unleashed' },
				},
			},
		})
		expect(fakeAccessNetworksUnleashed.calls).toContainEqual(
			expect.objectContaining({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
			}),
		)

		const accessNetworksBlockResult = await mcp.callTool(
			'access_networks_unleashed_request',
			{
				action: 'docmd',
				comp: 'stamgr',
				xmlBody:
					"<xcmd check-ability='10' tag='client' acl-id='1' client='aa:bb:cc:dd:ee:ff' cmd='block'><client client='aa:bb:cc:dd:ee:ff' acl-id='1' hostname=''/></xcmd>",
				updater: 'block.42',
				acknowledgeHighRisk: true,
				reason:
					'The client was identified as unauthorized and must be blocked right now.',
				confirmation: accessNetworksUnleashed.requestConfirmation,
			},
		)
		expect(accessNetworksBlockResult.structuredContent).toMatchObject({
			action: 'docmd',
			comp: 'stamgr',
			updater: 'block.42',
		})
		expect(fakeAccessNetworksUnleashed.calls).toContainEqual(
			expect.objectContaining({
				action: 'docmd',
				comp: 'stamgr',
				updater: 'block.42',
			}),
		)

		await expect(
			mcp.callTool('access_networks_unleashed_request', {
				action: 'docmd',
				comp: 'stamgr',
				xmlBody: '<bogus/>',
				acknowledgeHighRisk: false,
				reason:
					'Trying to call without acknowledgement to make sure the tool rejects the request.',
				confirmation: accessNetworksUnleashed.requestConfirmation,
			}),
		).rejects.toThrow('acknowledgeHighRisk')

		await mcp.callTool('bond_adopt_bridge', { bridgeId: 'MOCKBOND1' })
		bond.setToken('MOCKBOND1', 'mock-bond-token')
		const bondDevices = await mcp.callTool('bond_list_devices', {
			bridgeId: 'MOCKBOND1',
		})
		expect(bondDevices.structuredContent).toMatchObject({
			devices: expect.any(Array),
		})
		const shadeMove = await mcp.callTool('bond_shade_set_position', {
			bridgeId: 'MOCKBOND1',
			deviceId: 'mockdev1',
			position: 50,
		})
		expect(shadeMove.structuredContent).toMatchObject({
			argument: 50,
		})

		const routerStatus = await mcp.callTool('router_get_status')
		expect(routerStatus.structuredContent).toMatchObject({
			config: {
				configured: true,
			},
			router: {
				version: {
					model: 'Island Pro',
				},
			},
		})
		const routerNeighbors = await mcp.callTool('router_run_command', {
			commandId: 'show ip neighbors',
		})
		expect(routerNeighbors.structuredContent).toMatchObject({
			commandId: 'show ip neighbors',
			commandLines: expect.arrayContaining(['show ip neighbors']),
		})
		const interfaceDetails = await mcp.callTool('router_run_command', {
			commandId: 'show interface',
			params: { interfaceName: 'en0' },
		})
		expect(interfaceDetails.structuredContent).toMatchObject({
			commandId: 'show interface',
			params: { interfaceName: 'en0' },
			commandLines: expect.arrayContaining(['show interface en0']),
		})
		const filteredLog = await mcp.callTool('router_run_command', {
			commandId: 'show log',
			query: 'carrier',
			limit: 1,
		})
		expect(filteredLog.structuredContent).toMatchObject({
			commandId: 'show log',
			lines: ['2026/05/04-13:17:58.001 4 pe-link: en1 carrier down'],
		})

		await expect(
			mcp.callTool('bond_release_bridge', { bridgeId: 'not-a-bridge' }),
		).rejects.toThrow('not-a-bridge')
	} finally {
		storage.close()
	}
})

test('mcp server exposes island router write tools when host verification is configured', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const samsungTv = createSamsungTvAdapter({
		config,
		state,
		storage,
	})
	const lutron = createLutronAdapter({
		config,
		state,
		storage,
	})
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})
	const bond = createBondAdapter({
		config,
		state,
		storage,
	})
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createIslandRouterRunner(),
	})
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})
	const venstar = createVenstarAdapter({ config, state, storage })
	const { accessNetworksUnleashed } = createAccessNetworksUnleashedFixture({
		config,
		state,
		storage,
	})
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
		samsungTv,
		lutron,
		sonos,
		bond,
		islandRouter,
		jellyfish,
		venstar,
		accessNetworksUnleashed,
	})

	try {
		const tools = mcp.listTools()
		expect(tools.some((tool) => tool.name === 'router_run_command')).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'router_run_write_operation'),
		).toBe(false)
		expect(tools.some((tool) => tool.name === 'router_run_read_command')).toBe(
			false,
		)
		expect(
			tools.some((tool) => tool.name === 'router_renew_dhcp_clients'),
		).toBe(false)

		const runCommandTool = tools.find(
			(tool) => tool.name === 'router_run_command',
		)
		if (!runCommandTool) {
			throw new Error('Expected router_run_command tool to be defined')
		}
		const writeProperties = (
			runCommandTool.inputSchema as {
				properties?: Record<string, Record<string, unknown>>
			}
		).properties
		expect(writeProperties?.commandId?.enum).toEqual(
			expect.arrayContaining([
				'show ip neighbors',
				'clear dhcp-client',
				'write memory',
				'ip dhcp-reserve',
				'interface description',
			]),
		)
		expect(writeProperties?.confirmation?.const).toBe(
			'I understand this allowlisted Island router command may affect live network behavior.',
		)

		const renewResult = await mcp.callTool('router_run_command', {
			commandId: 'clear dhcp-client',
			reason:
				'The uplink address changed and an immediate DHCP renewal is the explicit recovery step.',
			confirmation:
				'I understand this allowlisted Island router command may affect live network behavior.',
		})
		expect(renewResult.structuredContent).toMatchObject({
			commandId: 'clear dhcp-client',
			catalogEntry: {
				id: 'clear dhcp-client',
				riskLevel: 'networkWrite',
				blastRadius: expect.any(String),
			},
		})

		await expect(
			mcp.callTool('router_run_command', {
				commandId: 'write memory',
				reason:
					'Persist the currently validated maintenance change before the scheduled reboot window.',
				confirmation: 'wrong',
			}),
		).rejects.toThrow('requires the exact confirmation')
	} finally {
		storage.close()
	}
})
