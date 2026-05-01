import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { type HomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createTeslaGatewayAdapter, resetTeslaGatewayCaches } from './index.ts'
import {
	resetMockTeslaGatewayState,
	setMockTeslaGatewayExportLimitKw,
} from './mock-driver.ts'

installHomeConnectorMockServer()

function createConfig(dataPath: string): HomeConnectorConfig {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'home-connector-secret-home-connector-secret',
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: [],
		jellyfishScanCidrs: [],
		teslaGatewayScanCidrs: [],
		teslaGatewayDiscoveryUrl: 'http://tesla-gateway.mock.local/discovery',
		dataPath,
		dbPath: path.join(dataPath, 'home-connector.sqlite'),
		port: 4040,
		mocksEnabled: true,
	}
}

function makeAdapter() {
	resetMockTeslaGatewayState()
	resetTeslaGatewayCaches()
	const dataPath = mkdtempSync(path.join(tmpdir(), 'kody-tesla-gateway-'))
	const config = createConfig(dataPath)
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createTeslaGatewayAdapter({ config, state, storage })
	return {
		adapter,
		config,
		state,
		storage,
		[Symbol.dispose]() {
			storage.close()
			rmSync(dataPath, { recursive: true, force: true })
			resetTeslaGatewayCaches()
		},
	}
}

test('scan persists mock gateways from the JSON discovery feed', async () => {
	using env = makeAdapter()
	const gateways = await env.adapter.scan()
	expect(gateways).toHaveLength(2)
	expect(gateways.map((gateway) => gateway.gatewayId).sort()).toEqual([
		'tesla-gateway-mock-home-1',
		'tesla-gateway-mock-home-2',
	])
	expect(gateways[0]?.role).toBe('leader')
	expect(gateways[0]?.cert?.subjectOrganization).toBe('Tesla')
})

test('setCredentials, authenticate, and live snapshot exercise the full happy path', async () => {
	using env = makeAdapter()
	await env.adapter.scan()
	const gatewayId = 'tesla-gateway-mock-home-1'
	env.adapter.setCredentials({
		gatewayId,
		password: 'mock-password',
		customerEmailLabel: 'tester@local',
	})
	const authed = await env.adapter.authenticate(gatewayId)
	expect(authed.hasStoredCredentials).toBe(true)
	expect(authed.lastAuthError).toBeNull()
	expect(authed.lastAuthenticatedAt).toBeTruthy()

	const snapshot = await env.adapter.getLiveSnapshot(gatewayId)
	expect(Object.keys(snapshot.fetchErrors)).toEqual([])
	expect(snapshot.gateway.din).toMatch(/--GF/)
	expect(snapshot.gateway.serialNumber).toBeTruthy()
	expect(snapshot.systemStatus?.solar_real_power_limit).toBe(25_000)
	expect(snapshot.siteInfo?.max_site_meter_power_ac).toBe(25_000)
	expect(snapshot.gridStatus?.grid_status).toBe('SystemGridConnected')
	expect(snapshot.soe?.percentage).toBeGreaterThanOrEqual(0)
	expect(snapshot.meters?.solar?.instant_power).toBe(6_700)
	expect(snapshot.powerwalls?.powerwalls?.length ?? 0).toBe(3)
})

test('findExportLimit prefers max_site_meter_power_ac and reports source', async () => {
	using env = makeAdapter()
	await env.adapter.scan()
	const gatewayId = 'tesla-gateway-mock-home-1'
	env.adapter.setCredentials({ gatewayId, password: 'mock-password' })
	const info = await env.adapter.findExportLimit(gatewayId)
	expect(info.exportLimitKw).toBe(25)
	expect(info.exportLimitWatts).toBe(25_000)
	expect(info.source).toBe('site_info.max_site_meter_power_ac')
})

test('findAllExportLimits surfaces the configured cap for every gateway', async () => {
	using env = makeAdapter()
	await env.adapter.scan()
	for (const gateway of env.adapter.listGateways()) {
		env.adapter.setCredentials({
			gatewayId: gateway.gatewayId,
			password: 'mock-password',
		})
	}
	setMockTeslaGatewayExportLimitKw({
		host: 'tesla-gateway-home-2.mock.local',
		exportLimitKw: 17,
	})
	const results = await env.adapter.findAllExportLimits()
	expect(results).toHaveLength(2)
	expect(
		results.find((entry) => entry.gatewayId === 'tesla-gateway-mock-home-1')
			?.exportLimitKw,
	).toBe(25)
	expect(
		results.find((entry) => entry.gatewayId === 'tesla-gateway-mock-home-2')
			?.exportLimitKw,
	).toBe(17)
})

test('authenticate rejects an invalid mock password and records the error', async () => {
	using env = makeAdapter()
	await env.adapter.scan()
	const gatewayId = 'tesla-gateway-mock-home-1'
	env.adapter.setCredentials({ gatewayId, password: 'wrong-password' })
	await expect(env.adapter.authenticate(gatewayId)).rejects.toThrow(
		/credentials are invalid/i,
	)
	const gateway = env.adapter
		.listGateways()
		.find((entry) => entry.gatewayId === gatewayId)
	expect(gateway?.lastAuthError).toBeTruthy()
	expect(gateway?.lastAuthenticatedAt).toBeNull()
})

test('getLiveSnapshot fails when no credentials are stored', async () => {
	using env = makeAdapter()
	await env.adapter.scan()
	await expect(
		env.adapter.getLiveSnapshot('tesla-gateway-mock-home-1'),
	).rejects.toThrow(/missing stored credentials/i)
})
