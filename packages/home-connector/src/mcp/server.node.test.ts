import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../mocks/test-server.ts'
import { createLutronAdapter } from '../adapters/lutron/index.ts'
import { createSonosAdapter } from '../adapters/sonos/index.ts'
import { createSamsungTvAdapter } from '../adapters/samsung-tv/index.ts'
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
	await samsungTv.scan()
	await lutron.scan()
	await sonos.scan()
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
		samsungTv,
		lutron,
		sonos,
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
	} finally {
		storage.close()
	}
})
