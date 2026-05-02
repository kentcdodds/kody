import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../mocks/test-server.ts'
import { createBondAdapter } from '../adapters/bond/index.ts'
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
	return loadHomeConnectorConfig()
}

function createIslandRouterRunner() {
	return async (
		request: import('../adapters/island-router/types.ts').IslandRouterCommandRequest,
	) => {
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
					stdout:
						'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
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
					stdout: `Interface: ${request.interfaceName}\nLink State: up`,
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
					stdout: `Interface: ${request.interfaceName}\nAddress: 192.168.0.1/24`,
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
					stdout:
						'64 bytes from 192.168.0.52: icmp_seq=1 ttl=64 time=1.23 ms\n1 packets transmitted, 1 packets received, 0% packet loss',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 200,
				}
			default: {
				const _exhaustive: never = request
				throw new Error(
					`Unhandled fake Island router MCP request: ${String(_exhaustive)}`,
				)
			}
		}
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
	await samsungTv.scan()
	await lutron.scan()
	await sonos.scan()
	await bond.scan()
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
		expect(tools.some((tool) => tool.name === 'router_ping_host')).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_arp_entry')).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_dhcp_lease')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_get_recent_events'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_diagnose_host')).toBe(
			true,
		)
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
		const routerDiagnosis = await mcp.callTool('router_diagnose_host', {
			host: '192.168.0.52',
		})
		expect(routerDiagnosis.structuredContent).toMatchObject({
			host: {
				value: '192.168.0.52',
			},
			ping: {
				reachable: true,
			},
			arpEntry: {
				interfaceName: 'en0',
			},
			dhcpLease: {
				hostName: 'nas-box',
			},
		})

		await expect(
			mcp.callTool('bond_release_bridge', { bridgeId: 'not-a-bridge' }),
		).rejects.toThrow('not-a-bridge')
	} finally {
		storage.close()
	}
})
