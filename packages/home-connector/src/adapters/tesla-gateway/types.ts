/**
 * Types for the Tesla Backup Gateway 2 (and Powerwall+ leader gateway) local
 * HTTPS API. Endpoints are exposed at `https://<gateway-ip>/api/...` over a
 * self-signed TLS cert with subject `O=Tesla, OU=Tesla Energy Products` and a
 * SAN list including `DNS:teg`, `DNS:powerwall`, and `DNS:powerpack`.
 *
 * Customer-scope endpoints accept `username: "customer"` against
 * `POST /api/login/Basic`. Installer-scope endpoints (`/api/installer`,
 * `/api/config`) require installer credentials and are not exercised here.
 */

export type TeslaGatewayDiscoveryProtocol = 'subnet' | 'mdns' | 'json'

export type TeslaGatewayCertSummary = {
	subjectCommonName: string | null
	subjectOrganization: string | null
	subjectOrganizationalUnit: string | null
	issuerCommonName: string | null
	issuerOrganization: string | null
	subjectAltName: string | null
	fingerprint256: string | null
}

export type TeslaGatewayHostProbe = {
	host: string
	port: number
	tcpOpen: boolean
	cert: TeslaGatewayCertSummary | null
	macAddress: string | null
	macOui: string | null
	identifiedAsTesla: boolean
	identifiedAsLeader: boolean
	loginEndpointResponse: {
		status: number
		bodyPreview: string | null
	} | null
	error: string | null
}

export type TeslaGatewaySubnetProbeSummary = {
	cidrs: Array<string>
	hostsProbed: number
	teslaMatches: number
	leaderMatches: number
}

export type TeslaGatewayDiscoveryDiagnostics = {
	protocol: TeslaGatewayDiscoveryProtocol
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	hostProbes: Array<TeslaGatewayHostProbe>
	subnetProbe: TeslaGatewaySubnetProbeSummary | null
	errors: Array<string>
}

export type TeslaGatewayDiscoveredGateway = {
	gatewayId: string
	host: string
	port: number
	/**
	 * Only present after a successful `customer` login (or a mock fixture). The
	 * gateway DIN looks like `1232100-00-H--GF22327600010P`, where the segment
	 * after `--` is the BGW serial.
	 */
	din: string | null
	serialNumber: string | null
	macAddress: string | null
	macOui: string | null
	cert: TeslaGatewayCertSummary | null
	firmwareVersion: string | null
	role: 'leader' | 'follower' | 'unknown'
	lastSeenAt: string
}

export type TeslaGatewayDiscoveryResult = {
	gateways: Array<TeslaGatewayDiscoveredGateway>
	diagnostics: TeslaGatewayDiscoveryDiagnostics
}

export type TeslaGatewayPersistedRecord = TeslaGatewayDiscoveredGateway & {
	label: string | null
	customerEmailLabel: string
	password: string | null
	lastAuthenticatedAt: string | null
	lastAuthError: string | null
}

export type TeslaGatewayPublicRecord = Omit<
	TeslaGatewayPersistedRecord,
	'password'
> & {
	hasStoredCredentials: boolean
}

export type TeslaGatewayLoginResponse = {
	cookies: Array<string>
	cookieHeader: string
	token: string | null
	email: string | null
	loginTimeIso: string | null
	expiresAtIso: string | null
}

export type TeslaGatewayApiStatusResponse = {
	din?: string
	start_time?: string
	up_time_seconds?: string | number
	is_new?: boolean
	version?: string
	git_hash?: string
	commission_count?: number
	device_type?: string
	teg_type?: string
	sync_type?: string
	cellular_disabled?: boolean
	can_reboot?: boolean
	[key: string]: unknown
}

export type TeslaGatewayInverterReport = {
	device_id?: string
	din?: string
	is_active?: boolean
	power_w?: number
	[key: string]: unknown
}

export type TeslaGatewaySystemStatusResponse = {
	command_source?: string
	battery_target_power?: number
	battery_target_reactive_power?: number
	nominal_full_pack_energy?: number
	nominal_energy_remaining?: number
	max_power_energy_remaining?: number
	max_power_energy_to_be_charged?: number
	max_charge_power?: number
	max_discharge_power?: number
	max_apparent_power?: number
	instantaneous_max_discharge_power?: number
	instantaneous_max_charge_power?: number
	instantaneous_max_apparent_power?: number
	hardware_capability_charge_power?: number
	hardware_capability_discharge_power?: number
	grid_services_power?: number
	system_island_state?: string
	available_blocks?: number
	available_charger_blocks?: number
	battery_blocks?: Array<Record<string, unknown>>
	ffr_power_availability_high?: number
	ffr_power_availability_low?: number
	load_charge_constraint?: number
	max_sustained_ramp_rate?: number
	grid_faults?: Array<Record<string, unknown>>
	can_reboot?: string
	smart_inv_delta_p?: number
	smart_inv_delta_q?: number
	last_toggle_timestamp?: string
	solar_real_power_limit?: number
	score?: number
	blocks_controlled?: number
	primary?: boolean
	auxiliary_load?: number
	all_enable_lines_high?: boolean
	inverter_nominal_usable_power?: number
	expected_energy_remaining?: number
	[key: string]: unknown
}

export type TeslaGatewayGridStatusResponse = {
	grid_status?: string
	grid_services_active?: boolean
	[key: string]: unknown
}

export type TeslaGatewaySoeResponse = {
	percentage?: number
	[key: string]: unknown
}

export type TeslaGatewayMeterAggregate = {
	last_communication_time?: string
	instant_power?: number
	instant_reactive_power?: number
	instant_apparent_power?: number
	frequency?: number
	energy_exported?: number
	energy_imported?: number
	instant_average_voltage?: number
	instant_average_current?: number
	i_a_current?: number
	i_b_current?: number
	i_c_current?: number
	last_phase_voltage_communication_time?: string
	last_phase_power_communication_time?: string
	last_phase_energy_communication_time?: string
	timeout?: number
	num_meters_aggregated?: number
	instant_total_current?: number
	[key: string]: unknown
}

export type TeslaGatewayMetersAggregatesResponse = {
	site?: TeslaGatewayMeterAggregate
	battery?: TeslaGatewayMeterAggregate
	load?: TeslaGatewayMeterAggregate
	solar?: TeslaGatewayMeterAggregate
	[key: string]: TeslaGatewayMeterAggregate | undefined
}

export type TeslaGatewayOperationResponse = {
	real_mode?: string
	backup_reserve_percent?: number
	[key: string]: unknown
}

export type TeslaGatewayNetworkInterface = {
	network_name?: string
	interface?: string
	dhcp?: boolean
	enabled?: boolean
	active?: boolean
	primary?: boolean
	lastTeslaConnected?: boolean
	lastInternetConnected?: boolean
	signal_strength?: number
	[key: string]: unknown
}

export type TeslaGatewayNetworksResponse = Array<TeslaGatewayNetworkInterface>

export type TeslaGatewaySiteInfoResponse = {
	max_system_energy_kWh?: number
	max_system_power_kW?: number
	site_name?: string
	timezone?: string
	max_site_meter_power_ac?: number
	min_site_meter_power_ac?: number
	nominal_system_energy_kWh?: number
	nominal_system_power_kW?: number
	panel_max_current?: number
	grid_code?: {
		grid_code?: string
		grid_voltage_setting?: number
		grid_freq_setting?: number
		grid_phase_setting?: string
		country?: string
		state?: string
		distributor?: string
		utility?: string
		retailer?: string
		region?: string
		[key: string]: unknown
	}
	measured_frequency?: number
	[key: string]: unknown
}

export type TeslaGatewayPowerwallEntry = {
	Type?: string
	PackagePartNumber?: string
	PackageSerialNumber?: string
	type?: string
	grid_state?: string
	commissioning_diagnostic?: Record<string, unknown>
	update_diagnostic?: Record<string, unknown>
	bc_type?: string | null
	in_config?: boolean
	[key: string]: unknown
}

export type TeslaGatewayPowerwallsResponse = {
	enumerating?: boolean
	updating?: boolean
	checking_if_offgrid?: boolean
	running_phase_detection?: boolean
	phase_detection_last_error?: string
	bubble_shedding?: boolean
	on_grid_check_error?: string
	grid_qualifying?: boolean
	grid_code_validating?: boolean
	phase_detection_not_available?: boolean
	powerwalls?: Array<TeslaGatewayPowerwallEntry>
	gateway_din?: string
	sync?: Record<string, unknown>
	msa?: Record<string, unknown>
	states?: Record<string, unknown>
	[key: string]: unknown
}

export type TeslaGatewaySolarPowerwallResponse = {
	pvac_status?: Record<string, unknown>
	pvs_status?: Record<string, unknown>
	pvi_status?: Record<string, unknown>
	mppt_status?: Record<string, unknown>
	power_status?: Record<string, unknown>
	[key: string]: unknown
}

export type TeslaGatewayGeneratorsResponse = {
	generators?: Array<Record<string, unknown>>
	[key: string]: unknown
}

export type TeslaGatewaySystemUpdateStatusResponse = {
	state?: string
	info?: { status?: Array<string>; [key: string]: unknown }
	current_time?: number
	last_status_time?: number
	version?: string
	offline_updating?: boolean
	offline_update_error?: string
	estimated_bytes_per_second?: number
	[key: string]: unknown
}

export type TeslaGatewayLiveSnapshot = {
	gateway: TeslaGatewayPublicRecord
	status: TeslaGatewayApiStatusResponse | null
	systemStatus: TeslaGatewaySystemStatusResponse | null
	gridStatus: TeslaGatewayGridStatusResponse | null
	soe: TeslaGatewaySoeResponse | null
	meters: TeslaGatewayMetersAggregatesResponse | null
	operation: TeslaGatewayOperationResponse | null
	networks: TeslaGatewayNetworksResponse | null
	siteInfo: TeslaGatewaySiteInfoResponse | null
	powerwalls: TeslaGatewayPowerwallsResponse | null
	solarPowerwall: TeslaGatewaySolarPowerwallResponse | null
	generators: TeslaGatewayGeneratorsResponse | null
	systemUpdateStatus: TeslaGatewaySystemUpdateStatusResponse | null
	fetchErrors: Record<string, string>
}
