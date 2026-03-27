import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import {
	listLutronProcessors,
	saveLutronCredentials,
	upsertDiscoveredLutronProcessors,
} from './repository.ts'
import { mockLutronProcessors } from './fixtures.ts'

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
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
	}
}

test('sqlite storage persists Lutron processors and associated credentials', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredLutronProcessors(storage, 'default', mockLutronProcessors)
		saveLutronCredentials({
			storage,
			connectorId: 'default',
			processorId: 'lutron-qsx-wireless',
			username: 'wireless-user',
			password: 'wireless-pass',
			lastAuthenticatedAt: '2026-03-25T17:05:00.000Z',
		})

		const processors = listLutronProcessors(storage, 'default')
		expect(processors).toHaveLength(2)
		expect(processors[0]).toMatchObject({
			processorId: 'lutron-qsx-main',
			leapPort: 8081,
			discoveryPort: 22,
			username: null,
		})
		expect(processors[1]).toMatchObject({
			processorId: 'lutron-qsx-wireless',
			leapPort: 8081,
			discoveryPort: 22,
			username: 'wireless-user',
			lastAuthenticatedAt: '2026-03-25T17:05:00.000Z',
		})
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})
