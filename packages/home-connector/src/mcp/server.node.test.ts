import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../mocks/test-server.ts'
import { createAccessNetworksUnleashedAdapter } from '../adapters/access-networks-unleashed/index.ts'
import { type AccessNetworksUnleashedClient } from '../adapters/access-networks-unleashed/types.ts'
import { createBondAdapter } from '../adapters/bond/index.ts'
import { type IslandRouterCommandRequest } from '../adapters/island-router/types.ts'
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
	process.env.ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS = '192.168.10.88/32'
	return loadHomeConnectorConfig()
}

function createIslandRouterRunner() {
	return async (request: IslandRouterCommandRequest) => {
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
			case 'show-system':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show stats'],
					stdout: [
						'Uptime: 4 days 03 hours',
						'CPU Usage: 17%',
						'Memory Usage: 41%',
						'Temperature: 46 C',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-hardware':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show hardware'],
					stdout: [
						'Platform Type: Island Pro',
						'CPU Type: ARM64',
						'Memory Size: 8 GB',
						'Power Supply Status: ok',
					].join('\n'),
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
			case 'show-interface-statistics':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show interface statistics'],
					stdout: [
						'Interface  RX Bytes  TX Bytes  RX Packets  TX Packets  RX Errors  TX Errors  Utilization',
						'---------  --------  --------  ----------  ----------  ---------  ---------  -----------',
						'en0        1000      2000      10          20          0          0          12%',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-bandwidth-usage':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show bandwidth-usage'],
					stdout: [
						'Interface  RX Rate   TX Rate   Total Rate',
						'---------  --------  --------  ----------',
						'en0        12 Mbps   4 Mbps    16 Mbps',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-wan':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show wan'],
					stdout: [
						'ISP  Interface  IP Address     Gateway       Type   Role    Priority',
						'---  ---------  -------------  ------------  -----  ------  --------',
						'Fiber       en1      203.0.113.10   203.0.113.1   dhcp   active   1',
						'LTE         en2      198.51.100.10  198.51.100.1  dhcp   standby  2',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-wan-failover':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show wan failover'],
					stdout: [
						'Active Interface: en1',
						'Policy: priority',
						'Interface  ISP    State    Role    Priority  Monitor',
						'---------  -----  -------  ------  --------  -------',
						'en1        Fiber  healthy  active   1         ping',
						'en2        LTE    healthy  standby  2         ping',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-multi-wan':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show multi-wan'],
					stdout: [
						'Active WAN: en1',
						'Policy: priority',
						'Interface  ISP    State    Role    Priority  Monitor',
						'---------  -----  -------  ------  --------  -------',
						'en1        Fiber  healthy  active   1         ping',
						'en2        LTE    healthy  standby  2         ping',
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
			case 'show-ip-routes':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip routes'],
					stdout: [
						'Destination      Gateway       Interface  Protocol  Metric',
						'---------------  ------------  ---------  --------  ------',
						'default          203.0.113.1   en1        static    1',
						'192.168.0.0/24   0.0.0.0       en0        kernel    0',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-nat':
			case 'show-ip-nat':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.id === 'show-nat' ? 'show nat' : 'show ip nat',
					],
					stdout: [
						'Rule  Type        Protocol  Interface  External        Internal         Enabled  Description',
						'----  ----------  --------  ---------  --------------  ---------------  -------  -----------',
						'1     port-forward  tcp       en1        203.0.113.10:443  192.168.0.52:443  enabled  NAS HTTPS',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-sessions':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show sessions'],
					stdout: [
						'Protocol  Source              Destination         State        Interface',
						'--------  ------------------  ------------------  -----------  ---------',
						'tcp       192.168.0.52:54321  1.1.1.1:443         established  en1',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-vlan':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show vlan'],
					stdout: [
						'VLAN  Name    Interface  Members      Status  IP Address',
						'----  ------  ---------  -----------  ------  ----------',
						'10    IOT     vlan10     en3,en4      up      192.168.10.1',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-dns':
			case 'show-ip-dns':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.id === 'show-dns' ? 'show dns' : 'show ip dns',
					],
					stdout: [
						'Mode: manual',
						'Address',
						'-------',
						'1.1.1.1',
						'8.8.8.8',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-users':
			case 'show-user':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.id === 'show-users' ? 'show users' : 'show user',
					],
					stdout: [
						'Username  Role   Connection  Address',
						'--------  -----  ----------  -------',
						'admin     admin  ssh         192.168.0.20',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-security-policy':
			case 'show-protection':
			case 'show-firewall':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.id === 'show-security-policy'
							? 'show security-policy'
							: request.id === 'show-protection'
								? 'show protection'
								: 'show firewall',
					],
					stdout: [
						'Rule  Action  Source        Destination  Service  Enabled',
						'----  ------  ------------  -----------  -------  -------',
						'10    allow   192.168.0.0/24 any         any      enabled',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-qos':
			case 'show-traffic-policy':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.id === 'show-qos' ? 'show qos' : 'show traffic-policy',
					],
					stdout: [
						'Policy  Interface  Class   Priority  Bandwidth  Enabled',
						'------  ---------  ------  --------  ---------  -------',
						'video   en1        voice   high      50 Mbps    enabled',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-vpn':
			case 'show-ipsec':
			case 'show-gre':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.id === 'show-vpn'
							? 'show vpn'
							: request.id === 'show-ipsec'
								? 'show ipsec'
								: 'show gre',
					],
					stdout: [
						'Name    Type   Local Endpoint  Remote Endpoint  Status  Interface',
						'------  -----  --------------  ---------------  ------  ---------',
						's2s     ipsec  203.0.113.10    203.0.113.20     up      en1',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-dhcp-server':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show dhcp-server'],
					stdout: [
						'Pool  Interface  Network         Range Start    Range End      Gateway      DNS Servers',
						'----  ---------  --------------  -------------  -------------  -----------  ----------------',
						'LAN   en0        192.168.0.0/24  192.168.0.100  192.168.0.199  192.168.0.1  1.1.1.1,8.8.8.8',
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
			case 'show-ntp':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ntp'],
					stdout: [
						'Timezone: America/Denver',
						'Server',
						'------',
						'time.cloudflare.com',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-syslog':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show syslog'],
					stdout: [
						'Host              Port  Protocol  Facility  Enabled',
						'----------------  ----  --------  --------  -------',
						'192.168.0.10      514   udp       local0    enabled',
					].join('\n'),
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-snmp':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show snmp'],
					stdout: [
						'Enabled: true',
						'Community  Access  Source',
						'---------  ------  -------',
						'public     ro      192.168.0.0/24',
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
					commandLines: [
						'terminal length 0',
						`show interface ${request.interfaceName}`,
					],
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
			case 'force-wan-failover':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`wan failover force ${request.interfaceName}`,
					],
					stdout: `Forced WAN failover to ${request.interfaceName}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'set-dhcp-reservation':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'dhcp-server reservation'],
					stdout: 'DHCP reservation updated.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'remove-dhcp-reservation':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'no dhcp-server reservation'],
					stdout: 'DHCP reservation removed.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'reboot':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'reload'],
					stdout: 'Reload requested.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'set-interface-description':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						'interface en0',
						'description "LAN uplink"',
					],
					stdout: 'Interface description updated.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'set-dns-server':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'ip name-server 1.1.1.1'],
					stdout: 'DNS servers updated.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'block-host':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						'firewall block-host 192.168.0.52',
					],
					stdout: 'Host blocked.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'unblock-host':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						'no firewall block-host 192.168.0.52',
					],
					stdout: 'Host unblocked.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'clear-dhcp-client':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'clear dhcp-client'],
					stdout: 'Renewing DHCP-learned addresses.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'clear-log':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'clear log'],
					stdout: 'System log buffer cleared.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
				}
			case 'write-memory':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'write memory'],
					stdout: 'Running configuration saved.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 150,
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

function createFakeAccessNetworksUnleashedClient() {
	const calls: Array<{ name: string; args: Array<unknown> }> = []
	const client: AccessNetworksUnleashedClient = {
		async getSystemInfo() {
			return {
				name: 'Access Networks Unleashed',
				version: '200.15.6.212',
			}
		},
		async listClients() {
			return [
				{
					mac: 'aa:bb:cc:dd:ee:ff',
					hostname: 'phone',
					wlan: 'Main',
				},
			]
		},
		async listAccessPoints() {
			return [
				{
					id: 1,
					mac: '24:79:de:ad:be:ef',
					name: 'Kitchen AP',
				},
			]
		},
		async listWlans() {
			return [
				{
					id: 1,
					name: 'Main',
					ssid: 'Main',
				},
			]
		},
		async listEvents(limit) {
			calls.push({ name: 'listEvents', args: [limit] })
			return [
				{
					message: 'client associated',
				},
			]
		},
		async blockClient(macAddress) {
			calls.push({ name: 'blockClient', args: [macAddress] })
		},
		async unblockClient(macAddress) {
			calls.push({ name: 'unblockClient', args: [macAddress] })
		},
		async setWlanEnabled(name, enabled) {
			calls.push({ name: 'setWlanEnabled', args: [name, enabled] })
		},
		async restartAccessPoint(macAddress) {
			calls.push({ name: 'restartAccessPoint', args: [macAddress] })
		},
		async setAccessPointLeds(macAddress, enabled) {
			calls.push({ name: 'setAccessPointLeds', args: [macAddress, enabled] })
		},
	}
	return { client, calls }
}

function createAccessNetworksUnleashedFixture(input: {
	config: ReturnType<typeof loadHomeConnectorConfig>
	state: ReturnType<typeof createAppState>
	storage: ReturnType<typeof createHomeConnectorStorage>
}) {
	const fakeClient = createFakeAccessNetworksUnleashedClient()
	const scannedControllers = [
		{
			controllerId: 'unleashed-1',
			name: 'Access Networks Unleashed',
			host: '192.168.10.88',
			loginUrl: 'https://192.168.10.88/admin/wsg/login.jsp',
			lastSeenAt: '2026-05-03T19:00:00.000Z',
			rawDiscovery: {
				probeUrl: 'https://192.168.10.88/',
			},
		},
	]
	const accessNetworksUnleashed = createAccessNetworksUnleashedAdapter({
		config: input.config,
		state: input.state,
		storage: input.storage,
		clientFactory: () => fakeClient.client,
		scanControllers: async () => ({
			controllers: scannedControllers,
			diagnostics: {
				protocol: 'subnet',
				discoveryUrl: input.config.accessNetworksUnleashedScanCidrs.join(', '),
				scannedAt: '2026-05-03T19:00:00.000Z',
				probes: [
					{
						host: '192.168.10.88',
						url: 'https://192.168.10.88/',
						matched: true,
						status: 302,
						location: '/admin/wsg/login.jsp',
						matchReason: 'redirect',
						error: null,
						bodySnippet: null,
					},
				],
				subnetProbe: {
					cidrs: input.config.accessNetworksUnleashedScanCidrs,
					hostsProbed: 1,
					controllerMatches: 1,
				},
			},
		}),
	})
	return {
		accessNetworksUnleashed,
		fakeClient,
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
	const { accessNetworksUnleashed, fakeClient: fakeAccessNetworksUnleashed } =
		createAccessNetworksUnleashedFixture({
			config,
			state,
			storage,
		})
	await samsungTv.scan()
	await lutron.scan()
	await sonos.scan()
	await bond.scan()
	await accessNetworksUnleashed.scan()
	const accessNetworksController =
		accessNetworksUnleashed.listControllers()[0]?.controllerId
	if (!accessNetworksController) {
		throw new Error(
			'Expected a discovered Access Networks Unleashed controller',
		)
	}
	accessNetworksUnleashed.adoptController({
		controllerId: accessNetworksController,
	})
	accessNetworksUnleashed.setCredentials({
		controllerId: accessNetworksController,
		username: 'admin',
		password: 'password',
	})
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
		accessNetworksUnleashed,
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
		expect(tools.some((tool) => tool.name === 'router_get_arp_entry')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_dhcp_lease')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_recent_events')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_diagnose_host')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_wan_config')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_get_failover_status'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_routing_table')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_nat_rules')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_vlan_config')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_dns_config')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_users')).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'router_get_security_policy'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_qos_config')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_traffic_stats')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_get_active_sessions'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_vpn_config')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_get_dhcp_server_config'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_get_ntp_config')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_syslog_config')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_snmp_config')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_get_system_info')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_get_bandwidth_usage'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'router_renew_dhcp_clients'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_clear_log_buffer')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_save_running_config'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_set_wan_failover')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_run_allowlisted_cli_command'),
		).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'router_set_dhcp_reservation'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_reboot')).toBe(true)
		expect(
			tools.some((tool) => tool.name === 'router_set_interface_description'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_set_dns_server')).toBe(
			true,
		)
		expect(tools.some((tool) => tool.name === 'router_block_host')).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_unblock_host')).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_scan_controllers',
			),
		).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_set_credentials',
			),
		).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_get_status',
			),
		).toBe(true)
		expect(
			tools.some(
				(tool) => tool.name === 'access_networks_unleashed_block_client',
			),
		).toBe(true)
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
		const accessNetworksCredentialsTool = tools.find(
			(tool) => tool.name === 'access_networks_unleashed_set_credentials',
		)
		if (!accessNetworksCredentialsTool) {
			throw new Error(
				'Expected access_networks_unleashed_set_credentials tool to be defined',
			)
		}
		const accessNetworksCredentialProperties = (
			accessNetworksCredentialsTool.inputSchema as {
				properties?: Record<string, Record<string, unknown>>
			}
		).properties
		expect(
			accessNetworksCredentialProperties?.username?.['x-kody-secret'],
		).toBe(true)
		expect(
			accessNetworksCredentialProperties?.password?.['x-kody-secret'],
		).toBe(true)

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

		const accessNetworksScan = await mcp.callTool(
			'access_networks_unleashed_scan_controllers',
		)
		expect(accessNetworksScan.structuredContent).toMatchObject({
			controllers: expect.any(Array),
			diagnostics: expect.anything(),
		})
		const accessNetworksControllers = await mcp.callTool(
			'access_networks_unleashed_list_controllers',
		)
		expect(accessNetworksControllers.structuredContent).toMatchObject({
			controllers: expect.arrayContaining([
				expect.objectContaining({
					controllerId: 'unleashed-1',
					adopted: true,
					hasStoredCredentials: true,
				}),
			]),
		})
		const accessNetworksStatus = await mcp.callTool(
			'access_networks_unleashed_get_status',
		)
		expect(accessNetworksStatus.structuredContent).toMatchObject({
			config: {
				configured: true,
			},
			controller: {
				controllerId: 'unleashed-1',
			},
			aps: expect.any(Array),
			wlans: expect.any(Array),
			clients: expect.any(Array),
		})
		const accessNetworksBlock = await mcp.callTool(
			'access_networks_unleashed_block_client',
			{
				macAddress: 'AA-BB-CC-DD-EE-FF',
				acknowledgeHighRisk: true,
				reason:
					'The client was identified as unauthorized and must be blocked now.',
				confirmation: accessNetworksUnleashed.writeAcknowledgements.blockClient,
			},
		)
		expect(accessNetworksBlock.structuredContent).toMatchObject({
			operation: 'block-client',
			target: 'aa:bb:cc:dd:ee:ff',
		})
		expect(fakeAccessNetworksUnleashed.calls).toContainEqual({
			name: 'blockClient',
			args: ['aa:bb:cc:dd:ee:ff'],
		})
		await mcp.callTool('access_networks_unleashed_list_events', { limit: 1 })
		expect(fakeAccessNetworksUnleashed.calls).toContainEqual({
			name: 'listEvents',
			args: [1],
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
		const wanConfig = await mcp.callTool('router_get_wan_config')
		expect(wanConfig.structuredContent).toMatchObject({
			wans: expect.arrayContaining([
				expect.objectContaining({
					interfaceName: 'en1',
					connectionType: 'dhcp',
				}),
			]),
		})
		const systemInfo = await mcp.callTool('router_get_system_info')
		expect(systemInfo.structuredContent).toMatchObject({
			uptime: expect.any(String),
			cpuUsagePercent: 17,
		})
		const activeSessions = await mcp.callTool('router_get_active_sessions')
		expect(activeSessions.structuredContent).toMatchObject({
			sessions: expect.arrayContaining([
				expect.objectContaining({
					sourceAddress: '192.168.0.52',
					destinationAddress: '1.1.1.1',
				}),
			]),
		})
		const allowlistedRouterCommand = await mcp.callTool(
			'router_run_allowlisted_cli_command',
			{
				acknowledgeHighRisk: true,
				reason:
					'The typed status tool is not sufficient and the allowlisted interface detail command is needed for diagnosis.',
				confirmation:
					'I am highly certain running this allowlisted Island router CLI command is necessary right now.',
				command: 'show-interface',
				interfaceName: 'en0',
			},
		)
		expect(allowlistedRouterCommand.structuredContent).toMatchObject({
			command: 'show-interface',
			commandId: 'show-interface',
		})

		await expect(
			mcp.callTool('bond_release_bridge', { bridgeId: 'not-a-bridge' }),
		).rejects.toThrow('not-a-bridge')
	} finally {
		storage.close()
	}
})

test('mcp server exposes island router write tools when host verification is configured', async () => {
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
	const { accessNetworksUnleashed } = createAccessNetworksUnleashedFixture({
		config,
		state,
		storage,
	})
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
		accessNetworksUnleashed,
	})

	try {
		const tools = mcp.listTools()
		expect(
			tools.some((tool) => tool.name === 'router_renew_dhcp_clients'),
		).toBe(true)
		expect(tools.some((tool) => tool.name === 'router_clear_log_buffer')).toBe(
			true,
		)
		expect(
			tools.some((tool) => tool.name === 'router_save_running_config'),
		).toBe(true)

		const renewTool = tools.find(
			(tool) => tool.name === 'router_renew_dhcp_clients',
		)
		if (!renewTool) {
			throw new Error('Expected router_renew_dhcp_clients tool to be defined')
		}
		const renewProperties = (
			renewTool.inputSchema as {
				properties?: Record<string, Record<string, unknown>>
			}
		).properties
		expect(renewProperties?.acknowledgeHighRisk?.const).toBe(true)
		expect(renewProperties?.confirmation?.const).toBe(
			'I am highly certain renewing all Island router DHCP clients is necessary right now.',
		)

		const renewResult = await mcp.callTool('router_renew_dhcp_clients', {
			acknowledgeHighRisk: true,
			reason:
				'The uplink address changed and an immediate DHCP renewal is the explicit recovery step.',
			confirmation:
				'I am highly certain renewing all Island router DHCP clients is necessary right now.',
		})
		expect(renewResult.structuredContent).toMatchObject({
			operationId: 'renew-dhcp-clients',
			commandId: 'clear-dhcp-client',
		})

		await expect(
			mcp.callTool('router_save_running_config', {
				acknowledgeHighRisk: true,
				reason:
					'Persist the currently validated maintenance change before the scheduled reboot window.',
				confirmation: 'wrong',
			}),
		).rejects.toThrow('requires the exact acknowledgement')
	} finally {
		storage.close()
	}
})
