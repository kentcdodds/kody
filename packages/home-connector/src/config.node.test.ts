import { expect, test } from 'vitest'
import {
	deriveVenstarAutoscanCidrsFromInterfaces,
	loadHomeConnectorConfig,
} from './config.ts'

const requiredConfigEnv = {
	HOME_CONNECTOR_ID: 'default',
	WORKER_BASE_URL: 'http://localhost:3742',
}

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

test('live connector applies discovery defaults when env overrides are absent', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		MOCKS: 'false',
		ROKU_DISCOVERY_URL: undefined,
		SONOS_DISCOVERY_URL: undefined,
		SAMSUNG_TV_DISCOVERY_URL: undefined,
		BOND_DISCOVERY_URL: undefined,
		LUTRON_DISCOVERY_URL: undefined,
		JELLYFISH_DISCOVERY_URL: undefined,
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		mocksEnabled: false,
		rokuDiscoveryUrl: 'ssdp://239.255.255.250:1900',
		sonosDiscoveryUrl:
			'ssdp://239.255.255.250:1900?st=urn:schemas-upnp-org:device:ZonePlayer:1',
		samsungTvDiscoveryUrl: 'mdns://_samsungmsf._tcp.local',
		bondDiscoveryUrl: 'mdns://_bond._tcp.local',
		lutronDiscoveryUrl: 'mdns://_lutron._tcp.local',
		jellyfishDiscoveryUrl: null,
	})
})

test('explicit discovery URLs override defaults in mock mode', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		MOCKS: 'true',
		ROKU_DISCOVERY_URL: 'http://roku.mock.local/discovery',
		SONOS_DISCOVERY_URL: 'http://sonos.mock.local/discovery',
		SAMSUNG_TV_DISCOVERY_URL: 'http://samsung-tv.mock.local/discovery',
		LUTRON_DISCOVERY_URL: 'http://lutron.mock.local/discovery',
		JELLYFISH_DISCOVERY_URL: 'http://jellyfish.mock.local/discovery',
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		mocksEnabled: true,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
	})
})

test('scan CIDR env vars override derived autoscan CIDRs', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		MOCKS: 'false',
		VENSTAR_SCAN_CIDRS: '192.168.1.0/24, 10.0.0.5/32',
		JELLYFISH_SCAN_CIDRS: '192.168.2.0/24, 10.0.0.6/32',
	})

	const config = loadHomeConnectorConfig()
	expect(config.venstarScanCidrs).toEqual(['192.168.1.0/24', '10.0.0.5/32'])
	expect(config.jellyfishScanCidrs).toEqual(['192.168.2.0/24', '10.0.0.6/32'])
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

test('db path can be derived from HOME_CONNECTOR_DATA_PATH', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		HOME_CONNECTOR_DATA_PATH: '/tmp/kody-home-connector',
		HOME_CONNECTOR_DB_PATH: undefined,
	})

	const config = loadHomeConnectorConfig()
	expect(config.dataPath).toBe('/tmp/kody-home-connector')
	expect(config.dbPath).toBe('/tmp/kody-home-connector/home-connector.sqlite')
})

test('HOME_CONNECTOR_DB_PATH overrides the default sqlite location', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		HOME_CONNECTOR_DATA_PATH: '/tmp/kody-home-connector',
		HOME_CONNECTOR_DB_PATH: '/tmp/custom-home-connector.sqlite',
	})

	const config = loadHomeConnectorConfig()
	expect(config.dbPath).toBe('/tmp/custom-home-connector.sqlite')
})

test('island router SSH env vars are loaded with defaults', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ISLAND_ROUTER_HOST: 'router.local',
		ISLAND_ROUTER_USERNAME: 'user',
		ISLAND_ROUTER_PRIVATE_KEY_PATH: '/keys/id_ed25519',
		ISLAND_ROUTER_PORT: undefined,
		ISLAND_ROUTER_KNOWN_HOSTS_PATH: '/keys/known_hosts',
		ISLAND_ROUTER_HOST_FINGERPRINT: undefined,
		ISLAND_ROUTER_COMMAND_TIMEOUT_MS: undefined,
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		islandRouterHost: 'router.local',
		islandRouterPort: 22,
		islandRouterUsername: 'user',
		islandRouterPrivateKeyPath: '/keys/id_ed25519',
		islandRouterKnownHostsPath: '/keys/known_hosts',
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8000,
	})
})

test('island router SSH env vars honor explicit port, fingerprint, and timeout', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ISLAND_ROUTER_HOST: '192.168.0.1',
		ISLAND_ROUTER_USERNAME: 'readonly',
		ISLAND_ROUTER_PRIVATE_KEY_PATH: '/keys/id_ed25519',
		ISLAND_ROUTER_PORT: '2222',
		ISLAND_ROUTER_KNOWN_HOSTS_PATH: undefined,
		ISLAND_ROUTER_HOST_FINGERPRINT:
			'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12',
		ISLAND_ROUTER_COMMAND_TIMEOUT_MS: '12000',
	})

	const config = loadHomeConnectorConfig()
	expect(config).toMatchObject({
		islandRouterHost: '192.168.0.1',
		islandRouterPort: 2222,
		islandRouterUsername: 'readonly',
		islandRouterPrivateKeyPath: '/keys/id_ed25519',
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint:
			'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12',
		islandRouterCommandTimeoutMs: 12000,
	})
})

test('Access Networks Unleashed insecure TLS is opt-in', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ACCESS_NETWORKS_UNLEASHED_HOST: 'https://unleashed.local',
		ACCESS_NETWORKS_UNLEASHED_USERNAME: 'admin',
		ACCESS_NETWORKS_UNLEASHED_PASSWORD: 'password',
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: undefined,
	})

	expect(loadHomeConnectorConfig()).toMatchObject({
		accessNetworksUnleashedHost: 'https://unleashed.local',
		accessNetworksUnleashedUsername: 'admin',
		accessNetworksUnleashedPassword: 'password',
		accessNetworksUnleashedAllowInsecureTls: false,
		accessNetworksUnleashedRequestTimeoutMs: 8000,
	})
})

test('Access Networks Unleashed insecure TLS honors explicit true', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ACCESS_NETWORKS_UNLEASHED_HOST: 'https://unleashed.local',
		ACCESS_NETWORKS_UNLEASHED_USERNAME: 'admin',
		ACCESS_NETWORKS_UNLEASHED_PASSWORD: 'password',
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'true',
		ACCESS_NETWORKS_UNLEASHED_REQUEST_TIMEOUT_MS: '12000',
	})

	expect(loadHomeConnectorConfig()).toMatchObject({
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 12000,
	})
})

test('invalid island router port falls back to default 22', () => {
	using _env = createTemporaryEnv({
		...requiredConfigEnv,
		ISLAND_ROUTER_HOST: '192.168.0.1',
		ISLAND_ROUTER_USERNAME: 'readonly',
		ISLAND_ROUTER_PRIVATE_KEY_PATH: '/keys/id_ed25519',
		ISLAND_ROUTER_PORT: '22junk',
	})

	const config = loadHomeConnectorConfig()
	expect(config.islandRouterPort).toBe(22)
})
