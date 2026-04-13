import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
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
		SONOS_DISCOVERY_URL: 'http://sonos.mock.local/discovery',
		SAMSUNG_TV_DISCOVERY_URL: 'http://samsung-tv.mock.local/discovery',
		LUTRON_DISCOVERY_URL: 'http://lutron.mock.local/discovery',
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.rokuDiscoveryUrl).toBe('http://roku.mock.local/discovery')
	expect(config.sonosDiscoveryUrl).toBe('http://sonos.mock.local/discovery')
	expect(config.samsungTvDiscoveryUrl).toBe(
		'http://samsung-tv.mock.local/discovery',
	)
	expect(config.lutronDiscoveryUrl).toBe('http://lutron.mock.local/discovery')
	expect(config.venstarThermostats).toEqual([])
})

test('live connector defaults Sonos discovery to SSDP', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		SONOS_DISCOVERY_URL: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.sonosDiscoveryUrl).toBe(
		'ssdp://239.255.255.250:1900?st=urn:schemas-upnp-org:device:ZonePlayer:1',
	)
})

test('live connector defaults Samsung TV discovery to mDNS', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		SAMSUNG_TV_DISCOVERY_URL: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.samsungTvDiscoveryUrl).toBe('mdns://_samsungmsf._tcp.local')
})

test('live connector defaults Bond discovery to mDNS', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		BOND_DISCOVERY_URL: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.bondDiscoveryUrl).toBe('mdns://_bond._tcp.local')
})

test('live connector defaults Venstar discovery to SSDP', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		VENSTAR_DISCOVERY_URL: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.venstarDiscoveryUrl).toBe(
		'ssdp://239.255.255.250:1900?st=venstar:thermostat:ecp&mx=2&timeoutMs=5000',
	)
})

test('Venstar subnet probe CIDRs load from VENSTAR_FALLBACK_CIDRS', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		VENSTAR_FALLBACK_CIDRS: '192.168.1.0/24, 10.0.0.5/32',
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.venstarSubnetProbeCidrs).toEqual([
		'192.168.1.0/24',
		'10.0.0.5/32',
	])
})

test('live connector defaults Lutron discovery to mDNS', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		LUTRON_DISCOVERY_URL: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.lutronDiscoveryUrl).toBe('mdns://_lutron._tcp.local')
})

test('loads Venstar thermostat configs from JSON', () => {
	using _env = createTemporaryEnv({
		VENSTAR_THERMOSTATS: JSON.stringify([
			{ name: 'Hallway', ip: '192.168.1.120' },
			{ name: 'Office', ip: '192.168.1.121' },
		]),
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.venstarThermostats).toEqual([
		{ name: 'Hallway', ip: '192.168.1.120' },
		{ name: 'Office', ip: '192.168.1.121' },
	])
})

test('db path can be derived from HOME_CONNECTOR_DATA_PATH', () => {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_DATA_PATH: '/tmp/kody-home-connector',
		HOME_CONNECTOR_DB_PATH: undefined,
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.dataPath).toBe('/tmp/kody-home-connector')
	expect(config.dbPath).toBe('/tmp/kody-home-connector/home-connector.sqlite')
})

test('HOME_CONNECTOR_DB_PATH overrides the default sqlite location', () => {
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_DATA_PATH: '/tmp/kody-home-connector',
		HOME_CONNECTOR_DB_PATH: '/tmp/custom-home-connector.sqlite',
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.dbPath).toBe('/tmp/custom-home-connector.sqlite')
})

test('VENSTAR_THERMOSTATS config parses valid entries', () => {
	using _env = createTemporaryEnv({
		VENSTAR_THERMOSTATS: JSON.stringify([
			{ name: 'Downstairs', ip: '10.0.0.10' },
			{ name: 'Upstairs', ip: 'http://10.0.0.11/' },
			{ name: '', ip: '10.0.0.12' },
		]),
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.venstarThermostats).toEqual([
		{ name: 'Downstairs', ip: '10.0.0.10' },
		{ name: 'Upstairs', ip: 'http://10.0.0.11/' },
	])
})

test('venstar thermostats load from data path file', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-venstar-'))
	const filePath = path.join(directory, 'venstar-thermostats.json')
	try {
		writeFileSync(
			filePath,
			JSON.stringify([
				{ name: 'Office', ip: '192.168.1.12' },
				{ name: 'Guest', ip: '192.168.1.13' },
			]),
		)
		using _env = createTemporaryEnv({
			HOME_CONNECTOR_DATA_PATH: directory,
			VENSTAR_THERMOSTATS: undefined,
			HOME_CONNECTOR_ID: 'default',
			WORKER_BASE_URL: 'http://localhost:3742',
		})

		const config = loadHomeConnectorConfig()
		expect(config.venstarThermostats).toEqual([
			{ name: 'Office', ip: '192.168.1.12' },
			{ name: 'Guest', ip: '192.168.1.13' },
		])
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
