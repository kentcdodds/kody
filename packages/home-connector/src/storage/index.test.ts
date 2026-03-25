import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	adoptSamsungTvDevice,
	listSamsungTvDevices,
	saveSamsungTvToken,
	upsertDiscoveredSamsungTvs,
} from '../adapters/samsung-tv/repository.ts'
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
