import { expect, test } from 'vitest'
import {
	deriveVenstarAutoscanCidrsFromInterfaces,
	loadHomeConnectorConfig,
} from './config.ts'

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

test('explicit discovery URLs override defaults in mock mode', () => {
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

test('VENSTAR_SCAN_CIDRS overrides derived Venstar scan CIDRs', () => {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		VENSTAR_SCAN_CIDRS: '192.168.1.0/24, 10.0.0.5/32',
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
	})

	const config = loadHomeConnectorConfig()
	expect(config.venstarScanCidrs).toEqual(['192.168.1.0/24', '10.0.0.5/32'])
})

test('derived Venstar autoscan CIDRs split a /23 into /24 scan blocks', () => {
	expect(
		deriveVenstarAutoscanCidrsFromInterfaces({
			en0: [
				{
					address: '192.168.0.151',
					netmask: '255.255.254.0',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '192.168.0.151/23',
				},
			],
		}),
	).toEqual(['192.168.0.0/24', '192.168.1.0/24'])
})

test('derived Venstar autoscan CIDRs collapse narrower private ranges to one /24', () => {
	expect(
		deriveVenstarAutoscanCidrsFromInterfaces({
			en0: [
				{
					address: '192.168.4.18',
					netmask: '255.255.255.128',
					family: 'IPv4',
					mac: '00:00:00:00:00:00',
					internal: false,
					cidr: '192.168.4.18/25',
				},
			],
		}),
	).toEqual(['192.168.4.0/24'])
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
