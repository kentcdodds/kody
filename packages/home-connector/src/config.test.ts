import { expect, test } from 'bun:test'
import { loadHomeConnectorConfig } from './config.ts'

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

test('live connector defaults Roku discovery to SSDP', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		ROKU_DISCOVERY_URL: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.rokuDiscoveryUrl).toBe('ssdp://239.255.255.250:1900')
})

test('explicit Roku discovery URL overrides the default in mock mode', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'true',
		ROKU_DISCOVERY_URL: 'http://roku.mock.local/discovery',
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.rokuDiscoveryUrl).toBe('http://roku.mock.local/discovery')
})
