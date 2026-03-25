import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../mocks/test-server.ts'
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
	await samsungTv.scan()
	const mcp = createHomeConnectorMcpServer({
		config,
		state,
		samsungTv,
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

		const result = await mcp.callTool('samsung_list_devices')
		expect(result.structuredContent).toMatchObject({
			devices: expect.any(Array),
		})
	} finally {
		storage.close()
	}
})
