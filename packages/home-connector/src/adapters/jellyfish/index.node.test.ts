import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createJellyfishAdapter } from './index.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.JELLYFISH_DISCOVERY_URL = 'http://jellyfish.mock.local/discovery'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('jellyfish scan persists discovered controllers and diagnostics', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const controllers = await jellyfish.scan()
		const status = jellyfish.getStatus()
		expect(controllers).toHaveLength(1)
		expect(controllers[0]).toMatchObject({
			hostname: 'JellyFish-F348.local',
			host: 'jellyfish-f348.mock.local',
		})
		expect(status.diagnostics?.protocol).toBe('json')
	} finally {
		storage.close()
	}
})

test('jellyfish list methods return structured zones, patterns, and parsed pattern data', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const zones = await jellyfish.listZones()
		const patterns = await jellyfish.listPatterns()
		const pattern = await jellyfish.getPattern({
			patternPath: 'Colors/Blue',
		})

		expect(zones.controller).toMatchObject({
			hostname: 'JellyFish-F348.local',
		})
		expect(zones.zones).toEqual([
			expect.objectContaining({
				name: 'Zone',
				numPixels: 755,
			}),
		])
		expect(patterns.patterns).toEqual([
			expect.objectContaining({
				path: 'Christmas/Christmas Tree',
			}),
			expect.objectContaining({
				path: 'Colors/Blue',
			}),
		])
		expect(pattern.pattern).toMatchObject({
			path: 'Colors/Blue',
			data: expect.objectContaining({
				type: 'Color',
			}),
		})
	} finally {
		storage.close()
	}
})

test('jellyfish runPattern defaults to all zones when zoneNames are omitted', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const jellyfish = createJellyfishAdapter({
		config,
		state,
		storage,
	})

	try {
		const result = await jellyfish.runPattern({
			patternPath: 'Christmas/Christmas Tree',
		})
		expect(result.zoneNames).toEqual(['Zone'])
		expect(result.runPattern).toMatchObject({
			file: 'Christmas/Christmas Tree',
			data: '',
			state: 1,
			zoneName: ['Zone'],
		})
	} finally {
		storage.close()
	}
})
