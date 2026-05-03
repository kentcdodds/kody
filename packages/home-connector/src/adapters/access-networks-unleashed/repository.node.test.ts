import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import {
	getAdoptedAccessNetworksUnleashedController,
	listAccessNetworksUnleashedControllers,
	listAccessNetworksUnleashedPublicControllers,
	saveAccessNetworksUnleashedCredentials,
	upsertDiscoveredAccessNetworksUnleashedControllers,
	adoptAccessNetworksUnleashedController,
} from './repository.ts'

function createConfig(dbPath: string) {
	return {
		homeConnectorId: 'default',
		workerBaseUrl: 'http://localhost:3742',
		workerSessionUrl: 'http://localhost:3742/home/connectors/default',
		workerWebSocketUrl: 'ws://localhost:3742/home/connectors/default',
		sharedSecret: 'secret',
		accessNetworksUnleashedScanCidrs: ['192.168.1.10/32'],
		accessNetworksUnleashedAllowInsecureTls: true,
		accessNetworksUnleashedRequestTimeoutMs: 8_000,
		islandRouterHost: null,
		islandRouterPort: 22,
		islandRouterUsername: null,
		islandRouterPrivateKeyPath: null,
		islandRouterKnownHostsPath: null,
		islandRouterHostFingerprint: null,
		islandRouterCommandTimeoutMs: 8_000,
		rokuDiscoveryUrl: 'http://roku.mock.local/discovery',
		samsungTvDiscoveryUrl: 'http://samsung-tv.mock.local/discovery',
		lutronDiscoveryUrl: 'http://lutron.mock.local/discovery',
		sonosDiscoveryUrl: 'http://sonos.mock.local/discovery',
		bondDiscoveryUrl: 'http://bond.mock.local/discovery',
		bondRequestPaceMs: 0,
		bondCircuitBreakerCooldownMs: 0,
		jellyfishDiscoveryUrl: 'http://jellyfish.mock.local/discovery',
		venstarScanCidrs: ['192.168.10.40/32'],
		jellyfishScanCidrs: ['192.168.10.93/32'],
		dataPath: path.dirname(dbPath),
		dbPath,
		port: 4040,
		mocksEnabled: true,
	}
}

test('sqlite storage persists Unleashed controllers and encrypted credentials', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'kody-home-connector-'))
	const dbPath = path.join(directory, 'home-connector.sqlite')
	const storage = createHomeConnectorStorage(createConfig(dbPath))

	try {
		upsertDiscoveredAccessNetworksUnleashedControllers(storage, 'default', [
			{
				controllerId: '192.168.1.10',
				name: 'Unleashed Kitchen',
				host: '192.168.1.10',
				loginUrl: 'https://192.168.1.10/admin/wsg/login.jsp',
				lastSeenAt: '2026-05-03T19:20:00.000Z',
				rawDiscovery: { probeUrl: 'https://192.168.1.10/' },
			},
			{
				controllerId: '192.168.1.11',
				name: 'Unleashed Office',
				host: '192.168.1.11',
				loginUrl: 'https://192.168.1.11/admin/wsg/login.jsp',
				lastSeenAt: '2026-05-03T19:21:00.000Z',
				rawDiscovery: { probeUrl: 'https://192.168.1.11/' },
			},
		])
		adoptAccessNetworksUnleashedController(storage, 'default', '192.168.1.11')
		saveAccessNetworksUnleashedCredentials({
			storage,
			connectorId: 'default',
			controllerId: '192.168.1.11',
			username: 'admin-user',
			password: 'admin-pass',
			lastAuthenticatedAt: '2026-05-03T19:22:00.000Z',
		})

		const controllers = listAccessNetworksUnleashedControllers(
			storage,
			'default',
		)
		expect(controllers).toHaveLength(2)
		expect(
			getAdoptedAccessNetworksUnleashedController(storage, 'default'),
		).toMatchObject({
			controllerId: '192.168.1.11',
			adopted: true,
			username: 'admin-user',
			password: 'admin-pass',
			lastAuthenticatedAt: '2026-05-03T19:22:00.000Z',
		})

		const publicControllers = listAccessNetworksUnleashedPublicControllers(
			storage,
			'default',
		)
		expect(publicControllers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					controllerId: '192.168.1.10',
					adopted: false,
					hasStoredCredentials: false,
				}),
				expect.objectContaining({
					controllerId: '192.168.1.11',
					adopted: true,
					hasStoredCredentials: true,
					lastAuthenticatedAt: '2026-05-03T19:22:00.000Z',
				}),
			]),
		)

		const rawPasswordRow = storage.db
			.query(
				`
					SELECT password
					FROM access_networks_unleashed_credentials
					WHERE connector_id = ? AND controller_id = ?
				`,
			)
			.get('default', '192.168.1.11') as { password: string } | undefined
		expect(rawPasswordRow?.password).toMatch(/^enc:v1:/)
		expect(rawPasswordRow?.password).not.toContain('admin-pass')

		const mismatchedSecretStorage = createHomeConnectorStorage(
			createConfig(path.join(directory, 'wrong-secret.sqlite')),
		)
		try {
			upsertDiscoveredAccessNetworksUnleashedControllers(
				mismatchedSecretStorage,
				'default',
				[
					{
						controllerId: '192.168.1.11',
						name: 'Unleashed Office',
						host: '192.168.1.11',
						loginUrl: 'https://192.168.1.11/admin/wsg/login.jsp',
						lastSeenAt: '2026-05-03T19:21:00.000Z',
						rawDiscovery: { probeUrl: 'https://192.168.1.11/' },
					},
				],
			)
			const copiedCiphertext = rawPasswordRow?.password
			if (!copiedCiphertext) {
				throw new Error('Expected encrypted password row to exist')
			}
			mismatchedSecretStorage.db
				.query(
					`
						INSERT INTO access_networks_unleashed_credentials (
							connector_id,
							controller_id,
							username,
							password,
							last_authenticated_at,
							last_auth_error,
							updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?)
					`,
				)
				.run(
					'default',
					'192.168.1.11',
					'admin-user',
					copiedCiphertext,
					'2026-05-03T19:22:00.000Z',
					null,
					'2026-05-03T19:22:00.000Z',
				)

			expect(
				listAccessNetworksUnleashedPublicControllers(
					mismatchedSecretStorage,
					'default',
				),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						controllerId: '192.168.1.11',
						hasStoredCredentials: true,
					}),
				]),
			)
		} finally {
			mismatchedSecretStorage.close()
		}
	} finally {
		storage.close()
		rmSync(directory, {
			force: true,
			recursive: true,
		})
	}
})
