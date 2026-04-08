import { expect, test } from 'vitest'
import { installHomeConnectorMockServer } from '../../../mocks/test-server.ts'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createSonosAdapter } from './index.ts'

function createConfig() {
	process.env.MOCKS = 'true'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.SONOS_DISCOVERY_URL = 'http://sonos.mock.local/discovery'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	return loadHomeConnectorConfig()
}

installHomeConnectorMockServer()

test('sonos scan persists discovered players and diagnostics', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const status = sonos.getStatus()

		expect(players.length).toBeGreaterThan(0)
		expect(status.allPlayers.length).toBe(players.length)
		expect(status.diagnostics).not.toBeNull()
	} finally {
		storage.close()
	}
})

test('sonos favorite playback and queue operations work in mock mode', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const playerId = players[0]!.playerId
		sonos.adoptPlayer(playerId)

		const favorite = await sonos.playFavorite({
			playerId,
			title: 'Relaxing Piano Broadway Mix',
		})
		const queue = await sonos.listQueue(playerId)
		const statusAfterPlay = await sonos.getPlayerStatus(playerId)
		await sonos.removeQueueTrack({
			playerId,
			position: 1,
		})
		const queueAfterRemove = await sonos.listQueue(playerId)

		expect(favorite.title).toBe('Relaxing Piano Broadway Mix')
		expect(queue.length).toBeGreaterThan(0)
		expect(statusAfterPlay.transportState).toBe('PLAYING')
		expect(queueAfterRemove.length).toBe(queue.length - 1)
	} finally {
		storage.close()
	}
})

test('sonos grouping and audio input commands work in mock mode', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const sonos = createSonosAdapter({
		config,
		state,
		storage,
	})

	try {
		const players = await sonos.scan()
		const sourcePlayerId = players[0]!.playerId
		const secondPlayerId = players[1]!.playerId
		sonos.adoptPlayer(sourcePlayerId)
		sonos.adoptPlayer(secondPlayerId)

		await sonos.groupPlayers({
			playerId: secondPlayerId,
			coordinatorPlayerId: sourcePlayerId,
		})
		const groupsAfterGroup = await sonos.listGroups(sourcePlayerId)
		await sonos.selectAudioInput(sourcePlayerId)
		const audioInput = await sonos.getAudioInput(sourcePlayerId)
		await sonos.setLineInLevel(sourcePlayerId, 8, 8)
		await sonos.startLineInToGroup({
			sourcePlayerId,
			coordinatorPlayerId: sourcePlayerId,
		})
		await sonos.ungroupPlayer(secondPlayerId)
		const groupsAfterUngroup = await sonos.listGroups(sourcePlayerId)

		expect(groupsAfterGroup.some((group) => group.members.length === 2)).toBe(
			true,
		)
		expect(audioInput.supported).toBe(true)
		expect(audioInput.lineInUri).toContain('x-rincon-stream:')
		expect(
			groupsAfterUngroup.every((group) => group.members.length === 1),
		).toBe(true)
	} finally {
		storage.close()
	}
})
