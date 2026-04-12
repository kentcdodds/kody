import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../mocks/test-server.ts'
import { createBondAdapter } from '../adapters/bond/index.ts'
import { createLutronAdapter } from '../adapters/lutron/index.ts'
import { createSonosAdapter } from '../adapters/sonos/index.ts'
import { createSamsungTvAdapter } from '../adapters/samsung-tv/index.ts'
import { createVenstarAdapter } from '../adapters/venstar/index.ts'
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
	process.env.VENSTAR_THERMOSTATS = JSON.stringify([
		{ name: 'Hallway', ip: 'venstar.mock.local' },
	])
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('mcp server exposes Samsung tools and executes samsung_list_devices', async () => {
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
	const venstar = createVenstarAdapter({ config })
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
		expect(
			tools.some((tool) => tool.name === 'venstar_list_thermostats'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'venstar_get_thermostat_info'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'venstar_control_thermostat'),
		).toBe(true)
		const bondAuthGuide = await mcp.callTool('bond_authentication_guide')
		expect(bondAuthGuide.content[0]?.type).toBe('text')
		expect(
			String((bondAuthGuide.content[0] as { text?: string }).text),
		).toContain('/bond/setup')

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

		const sonosPlayers = await mcp.callTool('sonos_list_players')
		expect(sonosPlayers.structuredContent).toMatchObject({
			players: expect.any(Array),
		})

		const venstarThermostats = await mcp.callTool('venstar_list_thermostats')
		expect(venstarThermostats.structuredContent).toMatchObject({
			thermostats: expect.any(Array),
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

		await expect(
			mcp.callTool('bond_release_bridge', { bridgeId: 'not-a-bridge' }),
		).rejects.toThrow('not-a-bridge')
	} finally {
		storage.close()
	}
})
