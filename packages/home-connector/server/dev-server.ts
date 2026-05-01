process.env.NODE_ENV ??= 'development'
process.env.MOCKS ??= 'true'
process.env.ROKU_DISCOVERY_URL ??= 'http://roku.mock.local/discovery'
process.env.LUTRON_DISCOVERY_URL ??= 'http://lutron.mock.local/discovery'
process.env.SONOS_DISCOVERY_URL ??= 'http://sonos.mock.local/discovery'
process.env.SAMSUNG_TV_DISCOVERY_URL ??=
	'http://samsung-tv.mock.local/discovery'
process.env.BOND_DISCOVERY_URL ??= 'http://bond.mock.local/discovery'
process.env.VENSTAR_SCAN_CIDRS ??= '192.168.10.40/32,192.168.10.41/32'
process.env.TESLA_GATEWAY_DISCOVERY_URL ??=
	'http://tesla-gateway.mock.local/discovery'

await import('../src/sentry-init.ts')
await import('./index.ts')
