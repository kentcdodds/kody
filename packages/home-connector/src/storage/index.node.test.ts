import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	adoptBondBridge,
	listBondBridges,
	pruneNonAdoptedBondBridges,
	releaseBondBridge,
	saveBondToken,
	upsertDiscoveredBondBridges,
} from '../adapters/bond/repository.ts'
import {
	adoptSamsungTvDevice,
	listSamsungTvDevices,
	saveSamsungTvToken,
	upsertDiscoveredSamsungTvs,
} from '../adapters/samsung-tv/repository.ts'
import {
	listVenstarThermostats,
	removeVenstarThermostat,
	upsertVenstarThermostat,
} from '../adapters/venstar/repository.ts'
import { createHomeConnectorStorage } from './index.ts'

function createConfig(dbPath: string) {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
	}
}

test('sqlite storage persists Samsung TV devices and tokens', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredSamsungTvs(storage, 'default', [
			{
				deviceId: 'samsung-tv-one',
				name: 'Living Room The Frame',
				host: 'frame-tv.mock.local',
				serviceUrl: 'http://frame-tv.mock.local:8001/api/v2/',
				model: '24_PONTUSM_FTV',
				modelName: 'QN65LS03DAFXZA',
				macAddress: 'F4:DD:06:67:B6:16',
				frameTvSupport: true,
				tokenAuthSupport: true,
				powerState: 'on',
				lastSeenAt: '2026-03-25T17:00:00.000Z',
				adopted: false,
				rawDeviceInfo: {
					name: 'Living Room The Frame',
				},
			},
		])
		adoptSamsungTvDevice(storage, 'default', 'samsung-tv-one')
		saveSamsungTvToken({
			storage,
			connectorId: 'default',
			deviceId: 'samsung-tv-one',
			token: 'persisted-token',
			lastVerifiedAt: '2026-03-25T17:05:00.000Z',
		})

		const persistedDevices = listSamsungTvDevices(storage, 'default')
		expect(persistedDevices).toHaveLength(1)
		expect(persistedDevices[0]).toMatchObject({
			deviceId: 'samsung-tv-one',
			adopted: true,
			token: 'persisted-token',
			lastVerifiedAt: '2026-03-25T17:05:00.000Z',
		})
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('sqlite storage persists Bond bridges and tokens', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredBondBridges(storage, 'default', [
			{
				bridgeId: 'BONDTEST1',
				bondid: 'BONDTEST1',
				instanceName: 'BONDTEST1',
				host: 'bond.test.local',
				port: 80,
				address: '10.0.0.50',
				model: 'BD-TEST',
				fwVer: 'v1.0.0',
				lastSeenAt: '2026-04-11T12:00:00.000Z',
				rawDiscovery: { test: true },
			},
		])
		adoptBondBridge(storage, 'default', 'BONDTEST1')
		saveBondToken({
			storage,
			connectorId: 'default',
			bridgeId: 'BONDTEST1',
			token: 'secret-bond-token',
			lastVerifiedAt: '2026-04-11T12:05:00.000Z',
			lastAuthError: null,
		})

		const bridges = listBondBridges(storage, 'default')
		expect(bridges).toHaveLength(1)
		expect(bridges[0]).toMatchObject({
			bridgeId: 'BONDTEST1',
			adopted: true,
			hasStoredToken: true,
			host: 'bond.test.local',
		})

		expect(() =>
			releaseBondBridge(storage, 'default', 'missing-bridge'),
		).toThrow('missing-bridge')

		upsertDiscoveredBondBridges(storage, 'default', [
			{
				bridgeId: 'BONDGHOST',
				bondid: 'BONDGHOST',
				instanceName: 'BONDGHOST',
				host: 'ghost.local',
				port: 80,
				address: null,
				model: null,
				fwVer: null,
				lastSeenAt: '2026-04-11T13:00:00.000Z',
				rawDiscovery: {},
			},
		])
		expect(listBondBridges(storage, 'default')).toHaveLength(2)
		pruneNonAdoptedBondBridges(storage, 'default')
		const afterPrune = listBondBridges(storage, 'default')
		expect(afterPrune).toHaveLength(1)
		expect(afterPrune[0]?.bridgeId).toBe('BONDTEST1')
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})

test('sqlite storage persists Venstar managed thermostats', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertVenstarThermostat({
			storage,
			connectorId: 'default',
			name: 'Hallway',
			ip: '192.168.10.40',
			lastSeenAt: '2026-04-13T18:00:00.000Z',
		})
		upsertVenstarThermostat({
			storage,
			connectorId: 'default',
			name: 'Office',
			ip: '192.168.10.41',
		})

		expect(listVenstarThermostats(storage, 'default')).toEqual([
			{
				name: 'Hallway',
				ip: '192.168.10.40',
				lastSeenAt: '2026-04-13T18:00:00.000Z',
			},
			{
				name: 'Office',
				ip: '192.168.10.41',
				lastSeenAt: null,
			},
		])

		removeVenstarThermostat({
			storage,
			connectorId: 'default',
			ip: '192.168.10.41',
		})

		expect(listVenstarThermostats(storage, 'default')).toEqual([
			{
				name: 'Hallway',
				ip: '192.168.10.40',
				lastSeenAt: '2026-04-13T18:00:00.000Z',
			},
		])
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})
