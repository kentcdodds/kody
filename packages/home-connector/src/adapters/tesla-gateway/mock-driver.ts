/**
 * In-process mock for the Tesla Backup Gateway 2 local API. Used both by
 * tests and by the dev server when `MOCKS=true`. Hosts ending in
 * `.mock.local` are routed here directly without hitting the network so the
 * MSW HTTPS-with-self-signed-cert dance is unnecessary.
 *
 * Fixture shape mirrors the real-world responses recorded against pypowerwall
 * captures and the tesla-api community docs, with payload values kept small.
 */
import {
	type TeslaGatewayApiStatusResponse,
	type TeslaGatewayDiscoveredGateway,
	type TeslaGatewayGeneratorsResponse,
	type TeslaGatewayGridStatusResponse,
	type TeslaGatewayMetersAggregatesResponse,
	type TeslaGatewayNetworksResponse,
	type TeslaGatewayOperationResponse,
	type TeslaGatewayPowerwallsResponse,
	type TeslaGatewaySiteInfoResponse,
	type TeslaGatewaySoeResponse,
	type TeslaGatewaySolarPowerwallResponse,
	type TeslaGatewaySystemStatusResponse,
	type TeslaGatewaySystemUpdateStatusResponse,
} from './types.ts'

const DEFAULT_PASSWORD = 'mock-password'
const DEFAULT_EMAIL_LABEL = 'kody@local'

export type MockTeslaGatewayState = {
	gatewayId: string
	host: string
	din: string
	serialNumber: string
	siteName: string
	macAddress: string
	apiStatus: TeslaGatewayApiStatusResponse
	systemStatus: TeslaGatewaySystemStatusResponse
	gridStatus: TeslaGatewayGridStatusResponse
	soe: TeslaGatewaySoeResponse
	meters: TeslaGatewayMetersAggregatesResponse
	operation: TeslaGatewayOperationResponse
	networks: TeslaGatewayNetworksResponse
	siteInfo: TeslaGatewaySiteInfoResponse
	powerwalls: TeslaGatewayPowerwallsResponse
	solarPowerwall: TeslaGatewaySolarPowerwallResponse
	generators: TeslaGatewayGeneratorsResponse
	systemUpdateStatus: TeslaGatewaySystemUpdateStatusResponse
}

const MOCK_HOST_SUFFIX = '.mock.local'

function buildDefaultGateway(input: {
	gatewayId: string
	host: string
	din: string
	serial: string
	siteName: string
	macAddress: string
	exportLimitKw: number
}): MockTeslaGatewayState {
	const exportLimitWatts = input.exportLimitKw * 1_000
	return {
		gatewayId: input.gatewayId,
		host: input.host,
		din: input.din,
		serialNumber: input.serial,
		siteName: input.siteName,
		macAddress: input.macAddress,
		apiStatus: {
			din: input.din,
			start_time: '2026-04-15 03:42:11 +0000',
			up_time_seconds: 1_360_201,
			is_new: false,
			version: '24.40.10 5d4d8d1d',
			git_hash: '5d4d8d1d',
			commission_count: 1,
			device_type: 'teg',
			teg_type: 'leader',
			sync_type: 'leader',
			cellular_disabled: true,
			can_reboot: true,
		},
		systemStatus: {
			command_source: 'Configuration',
			battery_target_power: 0,
			battery_target_reactive_power: 0,
			nominal_full_pack_energy: 40_500,
			nominal_energy_remaining: 28_350,
			max_charge_power: 25_000,
			max_discharge_power: 25_000,
			max_apparent_power: 25_000,
			instantaneous_max_discharge_power: 25_000,
			instantaneous_max_charge_power: 25_000,
			instantaneous_max_apparent_power: 25_000,
			hardware_capability_charge_power: 27_000,
			hardware_capability_discharge_power: 27_000,
			grid_services_power: 0,
			system_island_state: 'SystemGridConnected',
			available_blocks: 3,
			available_charger_blocks: 3,
			battery_blocks: [],
			ffr_power_availability_high: 0,
			ffr_power_availability_low: 0,
			grid_faults: [],
			can_reboot: 'Yes',
			solar_real_power_limit: exportLimitWatts,
			score: 999,
			blocks_controlled: 3,
			primary: true,
		},
		gridStatus: {
			grid_status: 'SystemGridConnected',
			grid_services_active: false,
		},
		soe: {
			percentage: 70,
		},
		meters: {
			site: {
				instant_power: -1_200,
				instant_reactive_power: 0,
				instant_apparent_power: 1_200,
				frequency: 60,
				energy_exported: 1_234_567,
				energy_imported: 234_567,
				instant_average_voltage: 240,
				instant_average_current: 5,
				num_meters_aggregated: 1,
			},
			battery: {
				instant_power: -2_000,
				instant_reactive_power: 0,
				instant_apparent_power: 2_000,
				frequency: 60,
				energy_exported: 5_000_000,
				energy_imported: 4_500_000,
				instant_average_voltage: 240,
				instant_average_current: 8,
				num_meters_aggregated: 3,
			},
			load: {
				instant_power: 3_500,
				instant_apparent_power: 3_500,
				frequency: 60,
				energy_exported: 0,
				energy_imported: 9_876_543,
				instant_average_voltage: 240,
				instant_average_current: 14,
				num_meters_aggregated: 1,
			},
			solar: {
				instant_power: 6_700,
				instant_apparent_power: 6_700,
				frequency: 60,
				energy_exported: 12_345_678,
				energy_imported: 0,
				instant_average_voltage: 240,
				instant_average_current: 28,
				num_meters_aggregated: 1,
			},
		},
		operation: {
			real_mode: 'self_consumption',
			backup_reserve_percent: 20,
		},
		networks: [
			{
				network_name: 'EthType',
				interface: 'eth0',
				dhcp: true,
				enabled: true,
				active: true,
				primary: true,
			},
			{
				network_name: 'WifiType',
				interface: 'wlan0',
				dhcp: true,
				enabled: true,
				active: false,
				primary: false,
				signal_strength: -56,
			},
		],
		siteInfo: {
			site_name: input.siteName,
			timezone: 'America/Denver',
			max_system_energy_kWh: 40.5,
			max_system_power_kW: 25,
			max_site_meter_power_ac: exportLimitWatts,
			min_site_meter_power_ac: -exportLimitWatts,
			nominal_system_energy_kWh: 40.5,
			nominal_system_power_kW: 25,
			panel_max_current: 200,
			grid_code: {
				grid_code: 'IEEE_1547_2018',
				grid_voltage_setting: 240,
				grid_freq_setting: 60,
				grid_phase_setting: 'Split',
				country: 'United States',
				state: 'Utah',
				distributor: 'Rocky Mountain Power',
				utility: 'Rocky Mountain Power',
				region: 'IEEE_1547_2018',
			},
			measured_frequency: 60,
		},
		powerwalls: {
			enumerating: false,
			updating: false,
			checking_if_offgrid: false,
			running_phase_detection: false,
			bubble_shedding: false,
			grid_qualifying: false,
			grid_code_validating: false,
			phase_detection_not_available: false,
			gateway_din: input.din,
			powerwalls: [
				{
					Type: 'ACPW',
					PackagePartNumber: '2012170-25-E',
					PackageSerialNumber: 'TG12247200001A',
					type: 'ACPW',
					grid_state: 'Compliant',
					in_config: true,
				},
				{
					Type: 'ACPW',
					PackagePartNumber: '2012170-25-E',
					PackageSerialNumber: 'TG12247200002B',
					type: 'ACPW',
					grid_state: 'Compliant',
					in_config: true,
				},
				{
					Type: 'ACPW',
					PackagePartNumber: '2012170-25-E',
					PackageSerialNumber: 'TG12247200003C',
					type: 'ACPW',
					grid_state: 'Compliant',
					in_config: true,
				},
			],
		},
		solarPowerwall: {
			pvac_status: { state: 'PVAC_Active' },
			pvs_status: { state: 'PVS_Active' },
			pvi_status: { state: 'PVI_Active' },
			power_status: { real_power_w: 6_700 },
		},
		generators: {
			generators: [],
		},
		systemUpdateStatus: {
			state: 'idle',
			info: { status: ['<update_failed_or_skipped>'] },
			current_time: 1_716_000_000,
			version: '24.40.10 5d4d8d1d',
			offline_updating: false,
		},
	}
}

const mockGateways: Map<string, MockTeslaGatewayState> = new Map()
const mockPasswords: Map<string, { emailLabel: string; password: string }> =
	new Map()

function defineDefaultMocks() {
	const home1 = buildDefaultGateway({
		gatewayId: 'tesla-gateway-mock-home-1',
		host: 'tesla-gateway-home-1.mock.local',
		din: '1232100-00-H--GF22327600010H',
		serial: 'GF22327600010H',
		siteName: 'Mock Home 1',
		macAddress: '90:03:71:11:22:33',
		exportLimitKw: 25,
	})
	const home2 = buildDefaultGateway({
		gatewayId: 'tesla-gateway-mock-home-2',
		host: 'tesla-gateway-home-2.mock.local',
		din: '1232100-00-H--GF22327600011K',
		serial: 'GF22327600011K',
		siteName: 'Mock Home 2',
		macAddress: '90:03:71:44:55:66',
		exportLimitKw: 25,
	})
	mockGateways.set(home1.host, home1)
	mockGateways.set(home2.host, home2)
	mockPasswords.set(home1.host, {
		emailLabel: DEFAULT_EMAIL_LABEL,
		password: DEFAULT_PASSWORD,
	})
	mockPasswords.set(home2.host, {
		emailLabel: DEFAULT_EMAIL_LABEL,
		password: DEFAULT_PASSWORD,
	})
}

export function resetMockTeslaGatewayState() {
	mockGateways.clear()
	mockPasswords.clear()
	defineDefaultMocks()
}

defineDefaultMocks()

export function isMockTeslaGatewayHost(host: string) {
	return host.endsWith(MOCK_HOST_SUFFIX)
}

export function listMockTeslaGatewayDiscoveryEntries(): Array<TeslaGatewayDiscoveredGateway> {
	const now = new Date().toISOString()
	return [...mockGateways.values()].map((gateway) => ({
		gatewayId: gateway.gatewayId,
		host: gateway.host,
		port: 443,
		din: gateway.din,
		serialNumber: gateway.serialNumber,
		macAddress: gateway.macAddress,
		macOui: gateway.macAddress.split(':').slice(0, 3).join(':'),
		cert: {
			subjectCommonName: 'GTW-' + gateway.serialNumber,
			subjectOrganization: 'Tesla',
			subjectOrganizationalUnit: 'Tesla Energy Products',
			issuerCommonName: 'Tesla Manufacturing CA',
			issuerOrganization: 'Tesla',
			subjectAltName: 'DNS:teg, DNS:powerwall, DNS:powerpack',
			fingerprint256: 'mock-fingerprint',
		},
		firmwareVersion: gateway.apiStatus.version ?? null,
		role: 'leader' as const,
		lastSeenAt: now,
	}))
}

function requireMockGateway(host: string) {
	const state = mockGateways.get(host)
	if (!state) {
		throw new Error(`Unknown mock Tesla gateway host "${host}".`)
	}
	return state
}

export function validateMockTeslaCredentials(input: {
	host: string
	emailLabel: string
	password: string
}) {
	const stored = mockPasswords.get(input.host)
	if (!stored) return false
	return stored.password === input.password
}

export function getMockTeslaApiStatus(host: string) {
	return requireMockGateway(host).apiStatus
}

export function getMockTeslaSystemStatus(host: string) {
	return requireMockGateway(host).systemStatus
}

export function getMockTeslaGridStatus(host: string) {
	return requireMockGateway(host).gridStatus
}

export function getMockTeslaSoe(host: string) {
	return requireMockGateway(host).soe
}

export function getMockTeslaMetersAggregates(host: string) {
	return requireMockGateway(host).meters
}

export function getMockTeslaOperation(host: string) {
	return requireMockGateway(host).operation
}

export function getMockTeslaNetworks(host: string) {
	return requireMockGateway(host).networks
}

export function getMockTeslaSiteInfo(host: string) {
	return requireMockGateway(host).siteInfo
}

export function getMockTeslaPowerwalls(host: string) {
	return requireMockGateway(host).powerwalls
}

export function getMockTeslaSolarPowerwall(host: string) {
	return requireMockGateway(host).solarPowerwall
}

export function getMockTeslaGenerators(host: string) {
	return requireMockGateway(host).generators
}

export function getMockTeslaSystemUpdateStatus(host: string) {
	return requireMockGateway(host).systemUpdateStatus
}

/**
 * Test helper to set the export-limit value on a single mock gateway. Used by
 * unit tests that assert curtailment detection logic.
 */
export function setMockTeslaGatewayExportLimitKw(input: {
	host: string
	exportLimitKw: number
}) {
	const state = requireMockGateway(input.host)
	const exportLimitWatts = input.exportLimitKw * 1_000
	state.systemStatus.solar_real_power_limit = exportLimitWatts
	state.siteInfo.max_site_meter_power_ac = exportLimitWatts
	state.siteInfo.min_site_meter_power_ac = -exportLimitWatts
	state.siteInfo.max_system_power_kW = input.exportLimitKw
}
