import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createIslandRouterAdapter } from './index.ts'
import {
	parseIslandRouterDhcpReservations,
	parseIslandRouterInterfaceSummaries,
	parseIslandRouterNeighbors,
	parseIslandRouterRecentEvents,
	parseIslandRouterVersion,
	sanitizeIslandRouterOutput,
} from './parsing.ts'
import { type IslandRouterCommandRequest } from './types.ts'

function withTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]() {
			for (const [key, value] of Object.entries(previousValues)) {
				if (value === undefined) {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

function createConfig() {
	process.env.MOCKS = 'false'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	process.env.ISLAND_ROUTER_HOST = 'router.local'
	process.env.ISLAND_ROUTER_PORT = '22'
	process.env.ISLAND_ROUTER_USERNAME = 'user'
	process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH = '/keys/id_ed25519'
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT =
		'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12'
	process.env.ISLAND_ROUTER_COMMAND_TIMEOUT_MS = '5000'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	return loadHomeConnectorConfig()
}

function createFakeRunner() {
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
					commandLines: ['terminal length 0', 'show system'],
					stdout: [
						'Uptime: 5 days 2 hours',
						'CPU Usage: 17%',
						'Memory Usage: 42%',
						'Temperature: 54 C',
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
						'en1        down   1G     full    spare port',
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
						'en0        1200000   2400000   1000        1500        0          1          37%',
						'en1        100       200       1           2           0          0          1%',
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
						'Subject            Interface  RX Rate   TX Rate   Total Rate',
						'-----------------  ---------  --------  --------  ----------',
						'192.168.0.52       en0        12 Mbps   2 Mbps    14 Mbps',
						'WAN aggregate      en1        150 Mbps  20 Mbps   170 Mbps',
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
						'ISP          Interface  IP Address     Gateway       Type   Role    Priority  Status',
						'-----------  ---------  -------------  ------------  -----  ------  --------  ------',
						'Fiber        en1        203.0.113.10   203.0.113.1   DHCP   active  1         up',
						'LTE Backup   en2        198.51.100.22  198.51.100.1  DHCP   standby   2         up',
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
						'Active ISP: Fiber',
						'Policy: priority',
						'Interface  ISP         Health  Role     Priority  Monitor',
						'---------  ----------  ------  -------  --------  ----------------',
						'en1        Fiber       up      active   1         8.8.8.8',
						'en2        LTE Backup up      standby  2         1.1.1.1',
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
						'Active Interface: en1',
						'Policy: priority',
						'Interface  ISP         Status   Priority',
						'---------  ----------  -------  --------',
						'en1        Fiber       active   1',
						'en2        LTE Backup standby  2',
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
						'192.168.0.1   aa:bb:cc:dd:ee:ff  en0        reachable',
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
						'Destination      Gateway       Interface  Protocol  Metric  Selected',
						'---------------  ------------  ---------  --------  ------  --------',
						'default          203.0.113.1   en1        static    1       yes',
						'192.168.0.0/24   0.0.0.0       en0        kernel    0       yes',
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
						'Rule  Type         Protocol  Interface  External         Internal         Enabled  Description',
						'----  -----------  --------  ---------  ---------------  ---------------  -------  -----------',
						'1     port-forward  tcp       en1        203.0.113.10:80  192.168.0.52:80  yes      NAS web',
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
						'Protocol  Source                Destination           Translated            State        Interface',
						'--------  --------------------  --------------------  --------------------  -----------  ---------',
						'tcp       192.168.0.52:51514    93.184.216.34:443     203.0.113.10:51514   established  en1',
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
						'VLAN  Name    Interface  Members     Status  Address',
						'----  ------  ---------  ----------  ------  -------------',
						'10    Main    vlan10     en0,en3     up      192.168.0.1/24',
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
						'Mode: forwarding',
						'Search Domains: home.arpa, lan',
						'Server  Role       Source',
						'------  ---------  --------',
						'1.1.1.1 upstream   static',
						'8.8.8.8 upstream   dhcp',
						'host=nas.home.arpa value=192.168.0.52 enabled=yes',
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
						'Username  Group   Role       Connection  Address        Connected',
						'--------  ------  ---------  ----------  -------------  ---------',
						'admin     admins  admin      ssh         192.168.0.20   yes',
						'user      users   readonly   web         192.168.0.30   yes',
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
						'Rule  Name         Action  Source         Destination    Service  Enabled',
						'----  -----------  ------  -------------  -------------  -------  -------',
						'10    block-guest  deny    192.168.0.99   any            any      yes',
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
						'Policy   Interface  Class      Priority  Bandwidth  Enabled',
						'-------  ---------  ---------  --------  ---------  -------',
						'wan-qos  en1        voice      high      10 Mbps    yes',
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
						'Tunnel      Type   Local          Remote         Status  Interface',
						'----------  -----  -------------  -------------  ------  ---------',
						'office-ipsec  ipsec  203.0.113.10   198.51.100.20  up      tun0',
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
			case 'show-dhcp-server':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show dhcp-server'],
					stdout: [
						'Pool  Interface  Network         Range Start    Range End      Gateway       DNS',
						'----  ---------  --------------  -------------  -------------  ------------  --------',
						'main  en0        192.168.0.0/24  192.168.0.50   192.168.0.199  192.168.0.1   1.1.1.1,8.8.8.8',
						'Option 6 value=1.1.1.1,8.8.8.8',
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
						'Server         Status  Source',
						'-------------  ------  ------',
						'162.159.200.1  synced  static',
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
						'Host            Port  Protocol  Facility  Enabled',
						'--------------  ----  --------  --------  -------',
						'192.168.0.60    514   udp       local0    yes',
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
						'Enabled: yes',
						'community=public access=ro source=192.168.0.0/24',
						'trap target=192.168.0.61 version=2c community=public',
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
					stdout: [
						'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
						'2026-05-02 15:50:10 warning dhcp: renewed lease for 192.168.0.52 00:11:22:33:44:55',
					].join('\n'),
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
					stdout: [
						`Interface: ${request.interfaceName}`,
						'Link State: up',
						'Speed: 1G',
						'Duplex: full',
					].join('\n'),
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
					stdout: [
						`Interface: ${request.interfaceName}`,
						'Address: 192.168.0.1/24',
						'DHCP Server: enabled',
					].join('\n'),
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
					stdout: [
						'64 bytes from 192.168.0.52: icmp_seq=1 ttl=64 time=1.23 ms',
						'64 bytes from 192.168.0.52: icmp_seq=2 ttl=64 time=1.17 ms',
						'2 packets transmitted, 2 packets received, 0% packet loss',
					].join('\n'),
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
					durationMs: 15,
				}
			case 'set-dhcp-reservation':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`dhcp-server reservation ${request.macAddress} ${request.ipAddress}`,
					],
					stdout: `Reservation set for ${request.macAddress}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'remove-dhcp-reservation':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						request.ipAddress
							? `no dhcp-server reservation ${request.macAddress} ${request.ipAddress}`
							: `no dhcp-server reservation ${request.macAddress}`,
					],
					stdout: `Reservation removed for ${request.macAddress}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'reboot':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'reload'],
					stdout: 'System reboot scheduled.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'set-interface-description':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`interface ${request.interfaceName}`,
						`description "${request.description}"`,
					],
					stdout: `Description updated for ${request.interfaceName}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'set-dns-server':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						...(request.interfaceName
							? [`interface ${request.interfaceName}`]
							: []),
						...request.servers.map((server) => `ip name-server ${server}`),
					],
					stdout: `DNS servers updated to ${request.servers.join(', ')}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'block-host':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`firewall block host ${request.host}`,
					],
					stdout: `Blocked ${request.host}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'unblock-host':
				return {
					id: request.id,
					commandLines: [
						'terminal length 0',
						`no firewall block host ${request.host}`,
					],
					stdout: `Unblocked ${request.host}.`,
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'clear-dhcp-client':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'clear dhcp-client'],
					stdout: 'DHCP client renewal requested.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
				}
			case 'clear-log':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'clear log'],
					stdout: 'Log buffer cleared.',
					stderr: '',
					exitCode: 0,
					signal: null,
					timedOut: false,
					durationMs: 15,
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
					durationMs: 15,
				}
			default: {
				const _exhaustive: never = request
				throw new Error(
					`Unhandled fake Island router request: ${String(_exhaustive)}`,
				)
			}
		}
	}
}

test('island router adapter returns status and diagnoses a host from typed SSH output', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(true)
	expect(status.router.version).toMatchObject({
		model: 'Island Pro',
		serialNumber: 'IR-12345',
		firmwareVersion: '2.3.2',
	})
	expect(status.interfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'en0',
				linkState: 'up',
			}),
		]),
	)

	const diagnosis = await islandRouter.diagnoseHost({
		host: '192.168.0.52',
		logLimit: 5,
	})
	expect(diagnosis.ping).toMatchObject({
		reachable: true,
		transmitted: 2,
		received: 2,
		packetLossPercent: 0,
	})
	expect(diagnosis.arpEntry).toMatchObject({
		ipAddress: '192.168.0.52',
		macAddress: '00:11:22:33:44:55',
		interfaceName: 'en0',
	})
	expect(diagnosis.dhcpLease).toMatchObject({
		ipAddress: '192.168.0.52',
		macAddress: '00:11:22:33:44:55',
		hostName: 'nas-box',
	})
	expect(diagnosis.interfaceSummary).toMatchObject({
		name: 'en0',
		linkState: 'up',
	})
	expect(diagnosis.interfaceDetails?.attributes).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'Link State',
				value: 'up',
			}),
		]),
	)
	expect(diagnosis.recentEvents).toHaveLength(2)
	expect(diagnosis.errors).toEqual([])
})

test('island router adapter reports incomplete configuration without opening SSH', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	process.env.ISLAND_ROUTER_HOST = ''
	process.env.ISLAND_ROUTER_USERNAME = ''
	process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH = ''
	const config = loadHomeConnectorConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(false)
	expect(status.config.configured).toBe(false)
	expect(status.errors[0]).toContain('ISLAND_ROUTER_HOST')
})

test('island router adapter marks malformed fingerprint config as not configured', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT = 'not-a-fingerprint'
	const config = loadHomeConnectorConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(false)
	expect(status.config.configured).toBe(false)
	expect(status.config.warnings).toEqual(
		expect.arrayContaining([
			expect.stringContaining('ISLAND_ROUTER_HOST_FINGERPRINT'),
		]),
	)
})

test('island router adapter exposes write capability status and runs typed write operations with verified SSH config', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	expect(islandRouter.getConfigStatus()).toMatchObject({
		writeCapabilitiesAvailable: true,
	})

	const renewResult = await islandRouter.renewDhcpClients({
		acknowledgeHighRisk: true,
		reason:
			'The WAN DHCP lease is stale after an upstream change and must be renewed intentionally.',
		confirmation: islandRouter.writeAcknowledgements.renewDhcpClients,
	})
	expect(renewResult).toMatchObject({
		operationId: 'renew-dhcp-clients',
		commandId: 'clear-dhcp-client',
		commandLines: ['terminal length 0', 'clear dhcp-client'],
	})

	const clearLogResult = await islandRouter.clearLogBuffer({
		acknowledgeHighRisk: true,
		reason:
			'The current in-memory log spam was already collected and must be cleared before reproducing the issue.',
		confirmation: islandRouter.writeAcknowledgements.clearLogBuffer,
	})
	expect(clearLogResult).toMatchObject({
		operationId: 'clear-log-buffer',
		commandId: 'clear-log',
		commandLines: ['terminal length 0', 'clear log'],
	})

	const saveConfigResult = await islandRouter.saveRunningConfig({
		acknowledgeHighRisk: true,
		reason:
			'The intended network change was validated manually and now needs to be persisted across reboot.',
		confirmation: islandRouter.writeAcknowledgements.saveRunningConfig,
	})
	expect(saveConfigResult).toMatchObject({
		operationId: 'save-running-config',
		commandId: 'write-memory',
		commandLines: ['terminal length 0', 'write memory'],
	})
})

test('island router adapter exposes expanded read and high-risk write capabilities', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	const wanConfig = await islandRouter.getWanConfig()
	expect(wanConfig.wans).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				interfaceName: 'en1',
				ispName: 'Fiber',
				connectionType: 'dhcp',
				role: 'active',
			}),
		]),
	)

	const failover = await islandRouter.getFailoverStatus()
	expect(failover).toMatchObject({
		activeInterfaceName: 'en1',
		activeIspName: 'Fiber',
		policy: 'priority',
	})

	const routingTable = await islandRouter.getRoutingTable()
	expect(routingTable.routes).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				destination: 'default',
				gateway: '203.0.113.1',
				interfaceName: 'en1',
			}),
		]),
	)

	const natRules = await islandRouter.getNatRules()
	expect(natRules.rules).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				ruleId: '1',
				externalAddress: '203.0.113.10',
				internalAddress: '192.168.0.52',
			}),
		]),
	)

	const vlanConfig = await islandRouter.getVlanConfig()
	expect(vlanConfig.vlans).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				vlanId: 10,
				interfaceName: 'vlan10',
			}),
		]),
	)

	const dnsConfig = await islandRouter.getDnsConfig()
	expect(dnsConfig).toMatchObject({
		mode: 'forwarding',
		searchDomains: ['home.arpa', 'lan'],
		servers: expect.arrayContaining([
			expect.objectContaining({
				address: '1.1.1.1 upstream',
			}),
		]),
	})

	const users = await islandRouter.getUsers()
	expect(users.users).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				username: 'admin',
			}),
		]),
	)

	const securityPolicy = await islandRouter.getSecurityPolicy()
	expect(securityPolicy.rules).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				action: 'deny',
			}),
		]),
	)

	const qos = await islandRouter.getQosConfig()
	expect(qos.policies).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				policyName: 'wan-qos',
				className: 'voice',
			}),
		]),
	)

	const trafficStats = await islandRouter.getTrafficStats()
	expect(trafficStats.interfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				interfaceName: 'en0',
				rxBytes: 1_200_000,
				txBytes: 2_400_000,
			}),
		]),
	)

	const activeSessions = await islandRouter.getActiveSessions()
	expect(activeSessions.sessions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				sourceAddress: '192.168.0.52',
				destinationAddress: '93.184.216.34',
				destinationPort: 443,
			}),
		]),
	)

	const vpn = await islandRouter.getVpnConfig()
	expect(vpn.tunnels).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				tunnelName: 'office-ipsec',
				type: 'ipsec',
			}),
		]),
	)

	const dhcpServerConfig = await islandRouter.getDhcpServerConfig()
	expect(dhcpServerConfig).toMatchObject({
		pools: expect.arrayContaining([
			expect.objectContaining({
				poolName: 'main',
			}),
		]),
		reservations: expect.arrayContaining([
			expect.objectContaining({
				macAddress: '00:11:22:33:44:55',
			}),
		]),
	})

	const ntpConfig = await islandRouter.getNtpConfig()
	expect(ntpConfig.servers).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				server: '162.159.200.1',
			}),
		]),
	)

	const syslogConfig = await islandRouter.getSyslogConfig()
	expect(syslogConfig.targets).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				host: '192.168.0.60',
				port: 514,
			}),
		]),
	)

	const snmpConfig = await islandRouter.getSnmpConfig()
	expect(snmpConfig).toMatchObject({
		enabled: true,
		trapTargets: expect.arrayContaining([
			expect.objectContaining({
				host: '192.168.0.61',
			}),
		]),
	})

	const systemInfo = await islandRouter.getSystemInfo()
	expect(systemInfo).toMatchObject({
		uptime: expect.stringContaining('days'),
		cpuUsagePercent: 17,
		memoryUsagePercent: 42,
		temperatureCelsius: 54,
	})

	const bandwidthUsage = await islandRouter.getBandwidthUsage()
	expect(bandwidthUsage.entries).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subject: '192.168.0.52',
				rxRate: '12 Mbps',
			}),
		]),
	)

	const allowlistedCommand = await islandRouter.runAllowlistedCliCommand({
		command: 'show-version',
		acknowledgeHighRisk: true,
		reason:
			'A targeted allowlisted diagnostic is needed because the typed version tool output must be compared during incident response.',
		confirmation: islandRouter.writeAcknowledgements.runAllowlistedCliCommand,
	})
	expect(allowlistedCommand).toMatchObject({
		command: 'show-version',
		commandId: 'show-version',
		result: {
			model: 'Island Pro',
		},
	})

	const wanFailover = await islandRouter.setWanFailover({
		interfaceName: 'en1',
		acknowledgeHighRisk: true,
		reason:
			'The primary WAN is degraded and traffic must be forced to the backup interface during a maintenance window.',
		confirmation: islandRouter.writeAcknowledgements.setWanFailover,
	})
	expect(wanFailover).toMatchObject({
		operationId: 'set-wan-failover',
		commandId: 'force-wan-failover',
	})

	const setReservation = await islandRouter.setDhcpReservation({
		action: 'set',
		macAddress: '00:11:22:33:44:66',
		ipAddress: '192.168.0.60',
		hostName: 'printer',
		interfaceName: 'en0',
		acknowledgeHighRisk: true,
		reason:
			'The printer requires a fixed IP reservation to restore LAN printing and the intended mapping was validated out of band.',
		confirmation: islandRouter.writeAcknowledgements.setDhcpReservation,
	})
	expect(setReservation).toMatchObject({
		commandId: 'set-dhcp-reservation',
	})

	const removeReservation = await islandRouter.setDhcpReservation({
		action: 'remove',
		macAddress: '00:11:22:33:44:66',
		ipAddress: '192.168.0.60',
		acknowledgeHighRisk: true,
		reason:
			'The old reservation must be removed because the device was decommissioned and the address needs to return to the DHCP pool.',
		confirmation: islandRouter.writeAcknowledgements.setDhcpReservation,
	})
	expect(removeReservation).toMatchObject({
		commandId: 'remove-dhcp-reservation',
	})

	const rebootResult = await islandRouter.rebootRouter({
		acknowledgeHighRisk: true,
		reason:
			'The router must be rebooted now because configuration drift persists after validated changes and an outage window is active.',
		confirmation: islandRouter.writeAcknowledgements.reboot,
	})
	expect(rebootResult).toMatchObject({
		commandId: 'reboot',
	})

	const descriptionResult = await islandRouter.setInterfaceDescription({
		interfaceName: 'en0',
		description: 'Main LAN uplink',
		acknowledgeHighRisk: true,
		reason:
			'The interface label needs to be corrected to avoid operator error during maintenance and the updated description is known-good.',
		confirmation: islandRouter.writeAcknowledgements.setInterfaceDescription,
	})
	expect(descriptionResult).toMatchObject({
		commandId: 'set-interface-description',
	})

	const dnsServerResult = await islandRouter.setDnsServer({
		servers: ['1.1.1.1', '8.8.8.8'],
		acknowledgeHighRisk: true,
		reason:
			'The resolver list must be updated intentionally because the upstream DNS providers changed and validation was completed already.',
		confirmation: islandRouter.writeAcknowledgements.setDnsServer,
	})
	expect(dnsServerResult).toMatchObject({
		commandId: 'set-dns-server',
	})

	const blockResult = await islandRouter.blockHost({
		host: '192.168.0.99',
		acknowledgeHighRisk: true,
		reason:
			'A compromised device must be isolated immediately and this IP was confirmed by incident response before enforcement.',
		confirmation: islandRouter.writeAcknowledgements.blockHost,
	})
	expect(blockResult).toMatchObject({
		commandId: 'block-host',
	})

	const unblockResult = await islandRouter.unblockHost({
		host: '192.168.0.99',
		acknowledgeHighRisk: true,
		reason:
			'The device was remediated and network access needs to be restored intentionally after post-incident validation.',
		confirmation: islandRouter.writeAcknowledgements.unblockHost,
	})
	expect(unblockResult).toMatchObject({
		commandId: 'unblock-host',
	})
})

test('island router adapter rejects write operations without host verification and exact confirmation', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT = ''
	const config = loadHomeConnectorConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: createFakeRunner(),
	})

	expect(islandRouter.getConfigStatus()).toMatchObject({
		writeCapabilitiesAvailable: false,
	})

	await expect(
		islandRouter.renewDhcpClients({
			acknowledgeHighRisk: true,
			reason:
				'The WAN DHCP lease is stale after an upstream change and must be renewed intentionally.',
			confirmation: islandRouter.writeAcknowledgements.renewDhcpClients,
		}),
	).rejects.toThrow('SSH host verification')

	process.env.ISLAND_ROUTER_HOST_FINGERPRINT =
		'SHA256:abcDEF1234567890abcDEF1234567890abcDEF12'
	const enabledConfig = loadHomeConnectorConfig()
	const enabledIslandRouter = createIslandRouterAdapter({
		config: enabledConfig,
		commandRunner: createFakeRunner(),
	})

	await expect(
		enabledIslandRouter.saveRunningConfig({
			acknowledgeHighRisk: false,
			reason:
				'The intended network change was validated manually and now needs to be persisted across reboot.',
			confirmation: enabledIslandRouter.writeAcknowledgements.saveRunningConfig,
		}),
	).rejects.toThrow('acknowledgeHighRisk=true')
	await expect(
		enabledIslandRouter.saveRunningConfig({
			acknowledgeHighRisk: true,
			reason: 'too short',
			confirmation: enabledIslandRouter.writeAcknowledgements.saveRunningConfig,
		}),
	).rejects.toThrow('specific operator reason')
	await expect(
		enabledIslandRouter.saveRunningConfig({
			acknowledgeHighRisk: true,
			reason:
				'The intended network change was validated manually and now needs to be persisted across reboot.',
			confirmation: 'I think this is probably okay.',
		}),
	).rejects.toThrow('exact acknowledgement')
})

test('fallback interface summary parsing recognizes up and down link states', () => {
	const summaries = parseIslandRouterInterfaceSummaries(
		['en0 up 1G full', 'en1 down 1G full'].join('\n'),
		['show interface summary'],
	)

	expect(summaries).toEqual([
		expect.objectContaining({
			name: 'en0',
			linkState: 'up',
		}),
		expect.objectContaining({
			name: 'en1',
			linkState: 'down',
		}),
	])
})

test('parser handles real Island CLI transcript shape with prompt echoes and goodbye', () => {
	const commandLines = ['terminal length 0', 'show version']
	const stdout = [
		'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
		'Copyright 2004-2026 PerfTech, Inc.',
		'',
		'Dodds-Island>show version',
		'',
		'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
		'Copyright 2004-2026 PerfTech, Inc.',
		'',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')

	expect(sanitizeIslandRouterOutput(stdout, commandLines)).toEqual([
		'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
		'Copyright 2004-2026 PerfTech, Inc.',
	])
	expect(parseIslandRouterVersion(stdout, commandLines)).toMatchObject({
		model: 'Island Pro',
		serialNumber: '08008A020104',
		firmwareVersion: '3.2.3',
		attributes: expect.arrayContaining([
			expect.objectContaining({
				key: 'Hardware Model',
				value: 'IL-0002-01',
			}),
		]),
	})
})

test('sanitizeIslandRouterOutput keeps legitimate lines that end with bracketed text', () => {
	const commandLines = ['terminal length 0', 'show version']
	const stdout = [
		'Dodds-Island>show version',
		'Firmware: v2.0 [beta]',
		'VLAN [100]',
		'Dodds-Island>',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')

	expect(sanitizeIslandRouterOutput(stdout, commandLines)).toEqual([
		'Firmware: v2.0 [beta]',
		'VLAN [100]',
	])
})

test('parser ignores prompt echoes for real neighbor, dhcp, and log transcripts', () => {
	const neighborsTranscript = [
		'Dodds-Island>show ip neighbors',
		'IP Address    MAC Address        Interface  State',
		'------------  -----------------  ---------  ---------',
		'192.168.0.52  00:11:22:33:44:55  en0        reachable',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')
	const dhcpTranscript = [
		'Dodds-Island>show ip dhcp-reservations',
		'IP Address    MAC Address        Host Name  Interface',
		'------------  -----------------  ---------  ---------',
		'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')
	const logTranscript = [
		'Dodds-Island>show log last where "192.168.0.52"',
		'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
		'Dodds-Island>exit',
		'Goodbye',
	].join('\n')

	expect(
		parseIslandRouterNeighbors(neighborsTranscript, [
			'terminal length 0',
			'show ip neighbors',
		]),
	).toEqual([
		expect.objectContaining({
			ipAddress: '192.168.0.52',
			macAddress: '00:11:22:33:44:55',
			interfaceName: 'en0',
			state: 'reachable',
		}),
	])
	expect(
		parseIslandRouterDhcpReservations(dhcpTranscript, [
			'terminal length 0',
			'show ip dhcp-reservations',
		]),
	).toEqual([
		expect.objectContaining({
			ipAddress: '192.168.0.52',
			macAddress: '00:11:22:33:44:55',
			hostName: 'nas-box',
			interfaceName: 'en0',
		}),
	])
	expect(
		parseIslandRouterRecentEvents(logTranscript, [
			'terminal length 0',
			'show log last where "192.168.0.52"',
		]),
	).toEqual([
		expect.objectContaining({
			timestamp: '2026-05-02 15:50:00',
			level: 'info',
			module: 'net',
		}),
	])
})

test('real CLI exit-code-1 transcripts remain successful when log output includes not-found text', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: async (request) => {
			switch (request.id) {
				case 'show-log':
					return {
						id: request.id,
						commandLines: [
							'terminal length 0',
							request.query
								? `show log last where "${request.query.replaceAll('"', '\\"')}"`
								: 'show log last',
						],
						stdout: [
							request.query
								? `Dodds-Island>show log last where "${request.query.replaceAll('"', '\\"')}"`
								: 'Dodds-Island>show log last',
							'2026-05-02 15:50:00 warning arp: ARP entry not found for 192.168.0.52',
							'2026-05-02 15:50:01 err net: TCP connection timed out while probing uplink',
							'Dodds-Island>exit',
							'Goodbye',
						].join('\n'),
						stderr: '',
						exitCode: 1,
						signal: null,
						timedOut: false,
						durationMs: 10,
					}
				default:
					return await createFakeRunner()(request)
			}
		},
	})

	const recentEvents = await islandRouter.getRecentEvents({
		host: '192.168.0.52',
	})

	expect(recentEvents).toEqual([
		expect.objectContaining({
			level: 'warning',
			module: 'arp',
			message: 'warning arp: ARP entry not found for 192.168.0.52',
		}),
		expect.objectContaining({
			level: 'err',
			module: 'net',
			message: 'err net: TCP connection timed out while probing uplink',
		}),
	])
})

test('island router adapter accepts real CLI transcripts that exit with code 1', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const realCliExitOneRunner = async (request: IslandRouterCommandRequest) => {
		switch (request.id) {
			case 'show-version':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show version'],
					stdout: [
						'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
						'Copyright 2004-2026 PerfTech, Inc.',
						'',
						'Dodds-Island>show version',
						'',
						'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3',
						'Copyright 2004-2026 PerfTech, Inc.',
						'',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-clock':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show clock'],
					stdout: [
						'Dodds-Island>show clock',
						'2026-05-02 15:55:00 PDT',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-interface-summary':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show interface summary'],
					stdout: [
						'Dodds-Island>show interface summary',
						'Interface  Link   Speed  Duplex  Description',
						'---------  -----  -----  ------  -----------',
						'en0        up     1G     full    LAN uplink',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-neighbors':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip neighbors'],
					stdout: [
						'Dodds-Island>show ip neighbors',
						'IP Address    MAC Address        Interface  State',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  en0        reachable',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'show-ip-dhcp-reservations':
				return {
					id: request.id,
					commandLines: ['terminal length 0', 'show ip dhcp-reservations'],
					stdout: [
						'Dodds-Island>show ip dhcp-reservations',
						'IP Address    MAC Address        Host Name  Interface',
						'------------  -----------------  ---------  ---------',
						'192.168.0.52  00:11:22:33:44:55  nas-box    en0',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
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
					stdout: [
						request.query
							? `Dodds-Island>show log last where "${request.query.replaceAll('"', '\\"')}"`
							: 'Dodds-Island>show log last',
						'2026-05-02 15:50:00 info net: 192.168.0.52 link flap detected on en0',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
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
					stdout: [
						`Dodds-Island>show interface ${request.interfaceName}`,
						`Interface: ${request.interfaceName}`,
						'Link State: up',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
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
					stdout: [
						`Dodds-Island>show ip interface ${request.interfaceName}`,
						`Interface: ${request.interfaceName}`,
						'Address: 192.168.0.1/24',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 10,
				}
			case 'ping':
				return {
					id: request.id,
					commandLines: ['terminal length 0', `ping ${request.host}`],
					stdout: [
						`Dodds-Island>ping ${request.host}`,
						'64 bytes from 192.168.0.52: icmp_seq=1 ttl=64 time=1.23 ms',
						'1 packets transmitted, 1 packets received, 0% packet loss',
						'Dodds-Island>exit',
						'Goodbye',
					].join('\n'),
					stderr: '',
					exitCode: 1,
					signal: null,
					timedOut: false,
					durationMs: 200,
				}
			default: {
				const _exhaustive: never = request
				throw new Error(
					`Unhandled fake Island router request: ${String(_exhaustive)}`,
				)
			}
		}
	}
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: realCliExitOneRunner,
	})

	const status = await islandRouter.getStatus()
	expect(status.connected).toBe(true)
	expect(status.router.version).toMatchObject({
		model: 'Island Pro',
		serialNumber: '08008A020104',
		firmwareVersion: '3.2.3',
	})

	const dhcpLease = await islandRouter.getDhcpLease({
		host: 'nas-box',
	})
	expect(dhcpLease.lease).toMatchObject({
		hostName: 'nas-box',
		ipAddress: '192.168.0.52',
	})

	const recentEvents = await islandRouter.getRecentEvents({
		host: '192.168.0.52',
	})
	expect(recentEvents).toEqual([
		expect.objectContaining({
			module: 'net',
			level: 'info',
		}),
	])
})

test('island router adapter forwards explicit timeoutMs to ARP and DHCP lookups', async () => {
	using _env = withTemporaryEnv({})
	createConfig()
	const config = createConfig()
	const recordedTimeouts: Array<number | undefined> = []
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: async (request) => {
			recordedTimeouts.push(request.timeoutMs)
			return await createFakeRunner()(request)
		},
	})

	await islandRouter.getArpEntry({
		host: '192.168.0.52',
		timeoutMs: 12_345,
	})
	await islandRouter.getDhcpLease({
		host: '192.168.0.52',
		timeoutMs: 23_456,
	})

	expect(recordedTimeouts).toContain(12_345)
	expect(recordedTimeouts).toContain(23_456)
})

test('island router adapter rejects null exit codes for lookup helpers', async () => {
	using _env = withTemporaryEnv({})
	const config = createConfig()
	const nullExitRunner = async (request: IslandRouterCommandRequest) => ({
		id: request.id,
		commandLines: [
			'terminal length 0',
			request.id === 'show-log' ? 'show log last' : 'show ip neighbors',
		],
		stdout: '',
		stderr: 'signal terminated',
		exitCode: null,
		signal: 'SIGTERM' as const,
		timedOut: false,
		durationMs: 10,
	})
	const islandRouter = createIslandRouterAdapter({
		config,
		commandRunner: nullExitRunner,
	})

	await expect(
		islandRouter.getArpEntry({
			host: '192.168.0.52',
		}),
	).rejects.toThrow('signal terminated')
	await expect(
		islandRouter.getDhcpLease({
			host: '192.168.0.52',
		}),
	).rejects.toThrow('signal terminated')
	await expect(
		islandRouter.getRecentEvents({
			host: '192.168.0.52',
		}),
	).rejects.toThrow('signal terminated')
})
