import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	getMockSonosAudioInput,
	getMockSonosGroupStatus,
	getMockSonosPlayerStatus,
	listMockSonosFavorites,
	listMockSonosGroups,
	listMockSonosLibraryEntries,
	listMockSonosQueue,
	listMockSonosSavedQueues,
	pauseMockSonos,
	playMockSonos,
	playMockSonosFavorite,
	playMockSonosSavedQueue,
	playMockSonosUri,
	previousMockSonosTrack,
	searchMockSonosFavorites,
	searchMockSonosLocalLibrary,
	searchMockSonosSavedQueues,
	selectMockSonosAudioInput,
	setMockSonosBass,
	setMockSonosLineInLevel,
	setMockSonosLoudness,
	setMockSonosMute,
	setMockSonosPlayMode,
	setMockSonosTreble,
	setMockSonosVolume,
	startMockSonosLineInToGroup,
	stopMockSonos,
	stopMockSonosLineInToGroup,
	groupMockSonosPlayers,
	adjustMockSonosVolume,
	clearMockSonosQueue,
	enqueueMockSonosFavorite,
	enqueueMockSonosSavedQueue,
	nextMockSonosTrack,
	removeMockSonosQueueTrack,
	seekMockSonosTrack,
	ungroupMockSonosPlayer,
} from './mock-driver.ts'
import {
	adoptSonosPlayer,
	listSonosPlayers,
	requireSonosPlayer,
	upsertDiscoveredSonosPlayers,
} from './repository.ts'
import {
	addSonosUriToQueueLive,
	browseAllSonosContent,
	clearSonosQueueLive,
	enqueueSonosEntryIntoQueueLive,
	getSonosAudioInputLive,
	getSonosBassLive,
	getSonosGroupsLive,
	getSonosLoudnessLive,
	getSonosMediaInfoLive,
	getSonosMuteLive,
	getSonosPositionInfoLive,
	getSonosTransportInfoLive,
	getSonosTrebleLive,
	getSonosVolumeLive,
	groupSonosPlayerLive,
	listSonosFavoritesLive,
	listSonosLibraryEntriesLive,
	listSonosQueueLive,
	listSonosSavedQueuesLive,
	nextSonosTrackLive,
	pauseSonosLive,
	playSonosLive,
	previousSonosTrackLive,
	removeSonosQueueTrackLive,
	searchSonosLocalLibraryLive,
	selectSonosAudioInputLive,
	setSonosBassLive,
	setSonosLineInLevelLive,
	setSonosLoudnessLive,
	setSonosMuteLive,
	setSonosPlayModeLive,
	setSonosRelativeVolumeLive,
	setSonosTransportUriLive,
	setSonosTrebleLive,
	setSonosVolumeLive,
	startSonosLineInToGroupLive,
	stopSonosLineInToGroupLive,
	stopSonosLive,
	stripSonosUuidPrefix,
	seekSonosTrackLive,
	ungroupSonosPlayerLive,
} from './soap-client.ts'
import { scanSonosPlayers } from './discovery.ts'
import {
	type SonosDidlEntry,
	type SonosFavorite,
	type SonosGroup,
	type SonosLibraryCategory,
	type SonosPersistedPlayer,
	type SonosSavedQueue,
} from './types.ts'

function isMockSonosHost(host: string) {
	return host.endsWith('.mock.local')
}

function normalizeQuery(value: string) {
	return value.trim().toLowerCase()
}

function matchByIdOrTitle<
	T extends { title: string | null } & Record<string, unknown>,
>(
	entries: Array<T>,
	input: {
		idField: string
		id?: string
		title?: string
	},
) {
	if (input.id) {
		const match = entries.find(
			(entry) => String(entry[input.idField] ?? '') === input.id,
		)
		if (match) return match
	}
	if (input.title) {
		const normalizedTitle = normalizeQuery(input.title)
		const exact = entries.find(
			(entry) => normalizeQuery(entry.title ?? '') === normalizedTitle,
		)
		if (exact) return exact
		const fuzzy = entries.find((entry) =>
			normalizeQuery(entry.title ?? '').includes(normalizedTitle),
		)
		if (fuzzy) return fuzzy
	}
	return null
}

export function createSonosAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	function getKnownPlayers() {
		return listSonosPlayers(input.storage, input.config.homeConnectorId)
	}

	function getAdoptedPlayers() {
		return getKnownPlayers().filter((player) => player.adopted)
	}

	function resolvePlayer(playerId?: string) {
		if (playerId) {
			return requireSonosPlayer(
				input.storage,
				input.config.homeConnectorId,
				playerId,
			)
		}
		const adoptedPlayers = getAdoptedPlayers()
		if (adoptedPlayers.length === 1) return adoptedPlayers[0]
		const allPlayers = getKnownPlayers()
		if (allPlayers.length === 1) return allPlayers[0]
		if (adoptedPlayers.length > 1 || allPlayers.length > 1) {
			throw new Error(
				'Multiple Sonos players are available. Specify a playerId.',
			)
		}
		throw new Error(
			'No Sonos players are currently known. Run sonos_scan_players first.',
		)
	}

	function resolveHouseholdPlayer(playerId?: string) {
		if (playerId) {
			const player = resolvePlayer(playerId)
			if (player.adopted) return player
			const adoptedPlayers = getAdoptedPlayers()
			return adoptedPlayers[0] ?? player
		}
		const adoptedPlayers = getAdoptedPlayers()
		if (adoptedPlayers[0]) return adoptedPlayers[0]
		const allPlayers = getKnownPlayers()
		if (allPlayers[0]) return allPlayers[0]
		throw new Error(
			'No Sonos players are currently known. Run sonos_scan_players first.',
		)
	}

	async function listGroups(playerId?: string) {
		const householdPlayer = resolveHouseholdPlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			return listMockSonosGroups()
		}
		return await getSonosGroupsLive({
			host: householdPlayer.host,
			players: getKnownPlayers(),
		})
	}

	async function listPlayersWithGroups() {
		const players = getKnownPlayers()
		const groups =
			players.length === 0 ? [] : await listGroups(players[0]?.playerId)
		const groupByPlayerId = new Map<string, SonosGroup>()
		for (const group of groups) {
			for (const member of group.members) {
				groupByPlayerId.set(member.playerId, group)
			}
		}
		return players.map((player) => ({
			...player,
			groupId: groupByPlayerId.get(player.playerId)?.groupId ?? null,
			coordinatorPlayerId:
				groupByPlayerId.get(player.playerId)?.coordinatorPlayerId ?? null,
		}))
	}

	async function getPlayerStatus(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return getMockSonosPlayerStatus(player.playerId)
		}
		const [
			groups,
			transport,
			media,
			position,
			volume,
			muted,
			bass,
			treble,
			loudness,
			audioInput,
		] = await Promise.all([
			listGroups(player.playerId),
			getSonosTransportInfoLive(player.host),
			getSonosMediaInfoLive(player.host),
			getSonosPositionInfoLive(player.host),
			getSonosVolumeLive(player.host),
			getSonosMuteLive(player.host),
			getSonosBassLive(player.host),
			getSonosTrebleLive(player.host),
			getSonosLoudnessLive(player.host),
			getSonosAudioInputLive({
				host: player.host,
				player,
			}),
		])
		return {
			player,
			group:
				groups.find((group) =>
					group.members.some((member) => member.playerId === player.playerId),
				) ?? null,
			transportState: transport.transportState,
			transportStatus: transport.transportStatus,
			currentUri: media.currentUri,
			trackUri: position.trackUri,
			trackTitle: position.trackTitle,
			trackArtist: position.trackArtist,
			trackAlbum: position.trackAlbum,
			trackPosition: position.trackPosition,
			queueLength: media.queueLength,
			volume,
			muted,
			bass,
			treble,
			loudness,
			audioInput,
		}
	}

	async function getGroupStatus(groupId: string, playerId?: string) {
		const groups = await listGroups(playerId)
		const group = groups.find((entry) => entry.groupId === groupId)
		if (!group) {
			throw new Error(`Sonos group "${groupId}" was not found.`)
		}
		if (
			input.config.mocksEnabled &&
			group.coordinatorPlayerId &&
			isMockSonosHost(resolvePlayer(group.coordinatorPlayerId).host)
		) {
			return getMockSonosGroupStatus(groupId)
		}
		const coordinator = resolvePlayer(group.coordinatorPlayerId ?? undefined)
		const [transport, media, position] = await Promise.all([
			getSonosTransportInfoLive(coordinator.host),
			getSonosMediaInfoLive(coordinator.host),
			getSonosPositionInfoLive(coordinator.host),
		])
		return {
			group,
			transportState: transport.transportState,
			transportStatus: transport.transportStatus,
			currentUri: media.currentUri,
			trackUri: position.trackUri,
			trackTitle: position.trackTitle,
			trackArtist: position.trackArtist,
			trackAlbum: position.trackAlbum,
			trackPosition: position.trackPosition,
			queueLength: media.queueLength,
		}
	}

	async function listFavorites(playerId?: string) {
		const householdPlayer = resolveHouseholdPlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			return listMockSonosFavorites()
		}
		return await listSonosFavoritesLive(householdPlayer.host)
	}

	async function searchFavorites(query: string, playerId?: string) {
		if (!query.trim()) {
			return await listFavorites(playerId)
		}
		const householdPlayer = resolveHouseholdPlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			return searchMockSonosFavorites(query)
		}
		return (await listFavorites(playerId)).filter((entry) =>
			normalizeQuery(entry.title ?? '').includes(normalizeQuery(query)),
		)
	}

	async function listSavedQueues(playerId?: string) {
		const householdPlayer = resolveHouseholdPlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			return listMockSonosSavedQueues()
		}
		return await listSonosSavedQueuesLive(householdPlayer.host)
	}

	async function searchSavedQueues(query: string, playerId?: string) {
		if (!query.trim()) {
			return await listSavedQueues(playerId)
		}
		const householdPlayer = resolveHouseholdPlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			return searchMockSonosSavedQueues(query)
		}
		return (await listSavedQueues(playerId)).filter((entry) =>
			normalizeQuery(entry.title ?? '').includes(normalizeQuery(query)),
		)
	}

	async function listQueue(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return listMockSonosQueue(player.playerId)
		}
		return await listSonosQueueLive({
			host: player.host,
			player,
		})
	}

	async function clearQueue(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			clearMockSonosQueue(player.playerId)
			return
		}
		await clearSonosQueueLive(player.host)
	}

	async function removeQueueTrack(inputArgs: {
		playerId?: string
		queueItemId?: string
		position?: number
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			removeMockSonosQueueTrack({
				playerId: player.playerId,
				queueItemId: inputArgs.queueItemId,
				position: inputArgs.position,
			})
			return
		}
		let queueItemId = inputArgs.queueItemId
		if (!queueItemId && typeof inputArgs.position === 'number') {
			const queue = await listQueue(player.playerId)
			queueItemId =
				queue.find((track) => track.position === inputArgs.position)
					?.queueItemId ?? null
		}
		if (!queueItemId) {
			throw new Error(
				'Specify a queueItemId or a valid 1-based queue position.',
			)
		}
		await removeSonosQueueTrackLive(player.host, queueItemId)
	}

	async function resolveFavorite(inputArgs: {
		playerId?: string
		favoriteId?: string
		title?: string
	}) {
		const favorites = await listFavorites(inputArgs.playerId)
		const favorite = matchByIdOrTitle(favorites, {
			idField: 'favoriteId',
			id: inputArgs.favoriteId,
			title: inputArgs.title,
		})
		if (!favorite) {
			throw new Error('Sonos favorite was not found.')
		}
		return favorite as SonosFavorite
	}

	async function resolveSavedQueue(inputArgs: {
		playerId?: string
		savedQueueId?: string
		title?: string
	}) {
		const savedQueues = await listSavedQueues(inputArgs.playerId)
		const savedQueue = matchByIdOrTitle(savedQueues, {
			idField: 'savedQueueId',
			id: inputArgs.savedQueueId,
			title: inputArgs.title,
		})
		if (!savedQueue) {
			throw new Error('Sonos saved queue was not found.')
		}
		return savedQueue as SonosSavedQueue
	}

	async function enqueueLiveEntry(
		player: SonosPersistedPlayer,
		entry: SonosDidlEntry,
	) {
		try {
			return await enqueueSonosEntryIntoQueueLive({
				host: player.host,
				entry,
			})
		} catch (error) {
			if (!entry.id) throw error
			const childEntries = await browseAllSonosContent({
				host: player.host,
				objectId: entry.id,
			})
			let added = 0
			for (const childEntry of childEntries) {
				if (!childEntry.uri) continue
				const result = await addSonosUriToQueueLive({
					host: player.host,
					uri: childEntry.uri,
					metadata: childEntry.metadata,
				})
				added += result.numTracksAdded
			}
			return {
				firstTrackNumberEnqueued: 1,
				numTracksAdded: added,
				newQueueLength: added,
			}
		}
	}

	async function enqueueFavorite(inputArgs: {
		playerId?: string
		favoriteId?: string
		title?: string
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return enqueueMockSonosFavorite({
				playerId: player.playerId,
				favoriteId: inputArgs.favoriteId,
				title: inputArgs.title,
			})
		}
		const favorite = await resolveFavorite(inputArgs)
		await enqueueLiveEntry(player, favorite)
		return favorite
	}

	async function playFavorite(inputArgs: {
		playerId?: string
		favoriteId?: string
		title?: string
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return playMockSonosFavorite({
				playerId: player.playerId,
				favoriteId: inputArgs.favoriteId,
				title: inputArgs.title,
			})
		}
		const favorite = await resolveFavorite(inputArgs)
		await clearQueue(player.playerId)
		await enqueueLiveEntry(player, favorite)
		await setSonosTransportUriLive({
			host: player.host,
			uri: `x-rincon-queue:${stripSonosUuidPrefix(player.udn)}#0`,
		})
		await playSonosLive(player.host)
		return favorite
	}

	async function enqueueSavedQueue(inputArgs: {
		playerId?: string
		savedQueueId?: string
		title?: string
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return enqueueMockSonosSavedQueue({
				playerId: player.playerId,
				savedQueueId: inputArgs.savedQueueId,
				title: inputArgs.title,
			})
		}
		const savedQueue = await resolveSavedQueue(inputArgs)
		await enqueueLiveEntry(player, savedQueue)
		return savedQueue
	}

	async function playSavedQueue(inputArgs: {
		playerId?: string
		savedQueueId?: string
		title?: string
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return playMockSonosSavedQueue({
				playerId: player.playerId,
				savedQueueId: inputArgs.savedQueueId,
				title: inputArgs.title,
			})
		}
		const savedQueue = await resolveSavedQueue(inputArgs)
		await clearQueue(player.playerId)
		await enqueueLiveEntry(player, savedQueue)
		await setSonosTransportUriLive({
			host: player.host,
			uri: `x-rincon-queue:${stripSonosUuidPrefix(player.udn)}#0`,
		})
		await playSonosLive(player.host)
		return savedQueue
	}

	async function play(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			playMockSonos(player.playerId)
			return
		}
		await playSonosLive(player.host)
	}

	async function pause(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			pauseMockSonos(player.playerId)
			return
		}
		await pauseSonosLive(player.host)
	}

	async function stop(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			stopMockSonos(player.playerId)
			return
		}
		await stopSonosLive(player.host)
	}

	async function nextTrack(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			nextMockSonosTrack(player.playerId)
			return
		}
		await nextSonosTrackLive(player.host)
	}

	async function previousTrack(playerId?: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			previousMockSonosTrack(player.playerId)
			return
		}
		await previousSonosTrackLive(player.host)
	}

	async function seek(playerId: string | undefined, position: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			seekMockSonosTrack(player.playerId, position)
			return
		}
		await seekSonosTrackLive(player.host, position)
	}

	async function setPlayMode(playerId: string | undefined, playMode: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosPlayMode(player.playerId, playMode)
			return
		}
		await setSonosPlayModeLive(player.host, playMode)
	}

	async function setVolume(playerId: string | undefined, volume: number) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosVolume(player.playerId, volume)
			return
		}
		await setSonosVolumeLive(player.host, volume)
	}

	async function adjustVolume(playerId: string | undefined, delta: number) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			adjustMockSonosVolume(player.playerId, delta)
			return
		}
		await setSonosRelativeVolumeLive(player.host, delta)
	}

	async function setMute(playerId: string | undefined, muted: boolean) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosMute(player.playerId, muted)
			return
		}
		await setSonosMuteLive(player.host, muted)
	}

	async function groupPlayers(inputArgs: {
		playerId: string
		coordinatorPlayerId: string
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		const coordinator = resolvePlayer(inputArgs.coordinatorPlayerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			groupMockSonosPlayers({
				playerId: player.playerId,
				coordinatorPlayerId: coordinator.playerId,
			})
			return
		}
		await groupSonosPlayerLive({
			host: player.host,
			coordinatorUdn: coordinator.udn,
		})
	}

	async function ungroupPlayer(playerId: string) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			ungroupMockSonosPlayer(player.playerId)
			return
		}
		await ungroupSonosPlayerLive(player.host)
	}

	async function getAudioInput(playerId: string | undefined) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			return getMockSonosAudioInput(player.playerId)
		}
		return await getSonosAudioInputLive({
			host: player.host,
			player,
		})
	}

	async function selectAudioInput(playerId: string | undefined) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			selectMockSonosAudioInput(player.playerId)
			return
		}
		await selectSonosAudioInputLive({
			host: player.host,
			player,
		})
	}

	async function setLineInLevel(
		playerId: string | undefined,
		leftLevel: number,
		rightLevel: number,
	) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosLineInLevel(player.playerId, leftLevel, rightLevel)
			return
		}
		await setSonosLineInLevelLive({
			host: player.host,
			leftLevel,
			rightLevel,
		})
	}

	async function startLineInToGroup(inputArgs: {
		sourcePlayerId: string
		coordinatorPlayerId: string
	}) {
		const sourcePlayer = resolvePlayer(inputArgs.sourcePlayerId)
		const coordinator = resolvePlayer(inputArgs.coordinatorPlayerId)
		if (input.config.mocksEnabled && isMockSonosHost(sourcePlayer.host)) {
			startMockSonosLineInToGroup({
				sourcePlayerId: sourcePlayer.playerId,
				coordinatorPlayerId: coordinator.playerId,
			})
			return
		}
		await startSonosLineInToGroupLive({
			host: sourcePlayer.host,
			coordinatorUdn: coordinator.udn,
		})
	}

	async function stopLineInToGroup(inputArgs: {
		sourcePlayerId: string
		coordinatorPlayerId: string
	}) {
		const sourcePlayer = resolvePlayer(inputArgs.sourcePlayerId)
		const coordinator = resolvePlayer(inputArgs.coordinatorPlayerId)
		if (input.config.mocksEnabled && isMockSonosHost(sourcePlayer.host)) {
			stopMockSonosLineInToGroup(sourcePlayer.playerId)
			return
		}
		await stopSonosLineInToGroupLive({
			host: sourcePlayer.host,
			coordinatorUdn: coordinator.udn,
		})
	}

	async function searchLocalLibrary(inputArgs: {
		query: string
		playerId?: string
		category?: SonosLibraryCategory
		limit?: number
	}) {
		const householdPlayer = resolveHouseholdPlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			return searchMockSonosLocalLibrary(inputArgs.query, inputArgs.category)
		}
		return await searchSonosLocalLibraryLive({
			host: householdPlayer.host,
			query: inputArgs.query,
			category: inputArgs.category,
			limit: inputArgs.limit,
		})
	}

	async function listLibraryEntries(inputArgs: {
		playerId?: string
		category: SonosLibraryCategory
		query?: string
		limit?: number
	}) {
		const householdPlayer = resolveHouseholdPlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(householdPlayer.host)) {
			const entries = listMockSonosLibraryEntries(inputArgs.category)
			return inputArgs.query
				? entries.filter((entry) =>
						normalizeQuery(entry.title ?? '').includes(
							normalizeQuery(inputArgs.query ?? ''),
						),
					)
				: entries
		}
		return await listSonosLibraryEntriesLive({
			host: householdPlayer.host,
			category: inputArgs.category,
			query: inputArgs.query,
			limit: inputArgs.limit,
		})
	}

	async function playUri(inputArgs: {
		playerId?: string
		uri: string
		metadata?: string
		title?: string | null
		artist?: string | null
		album?: string | null
	}) {
		const player = resolvePlayer(inputArgs.playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			playMockSonosUri({
				playerId: player.playerId,
				uri: inputArgs.uri,
				title: inputArgs.title,
				artist: inputArgs.artist,
				album: inputArgs.album,
			})
			return
		}
		await setSonosTransportUriLive({
			host: player.host,
			uri: inputArgs.uri,
			metadata: inputArgs.metadata,
		})
		await playSonosLive(player.host)
	}

	async function setBass(playerId: string | undefined, bass: number) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosBass(player.playerId, bass)
			return
		}
		await setSonosBassLive(player.host, bass)
	}

	async function setTreble(playerId: string | undefined, treble: number) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosTreble(player.playerId, treble)
			return
		}
		await setSonosTrebleLive(player.host, treble)
	}

	async function setLoudness(playerId: string | undefined, loudness: boolean) {
		const player = resolvePlayer(playerId)
		if (input.config.mocksEnabled && isMockSonosHost(player.host)) {
			setMockSonosLoudness(player.playerId, loudness)
			return
		}
		await setSonosLoudnessLive(player.host, loudness)
	}

	return {
		async scan() {
			const result = await scanSonosPlayers(input.state, input.config)
			return upsertDiscoveredSonosPlayers(
				input.storage,
				input.config.homeConnectorId,
				result.players,
			)
		},
		async listPlayers() {
			return await listPlayersWithGroups()
		},
		async listGroups(playerId?: string) {
			return await listGroups(playerId)
		},
		adoptPlayer(playerId: string) {
			const player = adoptSonosPlayer(
				input.storage,
				input.config.homeConnectorId,
				playerId,
			)
			if (!player) {
				throw new Error(`Sonos player "${playerId}" was not found.`)
			}
			return player
		},
		getStatus() {
			const players = getKnownPlayers()
			return {
				adopted: players.filter((player) => player.adopted),
				discovered: players.filter((player) => !player.adopted),
				allPlayers: players,
				audioInputSupportedCount: players.filter(
					(player) => player.audioInputSupported,
				).length,
				diagnostics: input.state.sonosDiscoveryDiagnostics,
			}
		},
		async getPlayerStatus(playerId?: string) {
			return await getPlayerStatus(playerId)
		},
		async getGroupStatus(groupId: string, playerId?: string) {
			return await getGroupStatus(groupId, playerId)
		},
		async play(playerId?: string) {
			await play(playerId)
		},
		async pause(playerId?: string) {
			await pause(playerId)
		},
		async stop(playerId?: string) {
			await stop(playerId)
		},
		async nextTrack(playerId?: string) {
			await nextTrack(playerId)
		},
		async previousTrack(playerId?: string) {
			await previousTrack(playerId)
		},
		async seek(playerId: string | undefined, position: string) {
			await seek(playerId, position)
		},
		async setPlayMode(playerId: string | undefined, playMode: string) {
			await setPlayMode(playerId, playMode)
		},
		async setVolume(playerId: string | undefined, volume: number) {
			await setVolume(playerId, volume)
		},
		async adjustVolume(playerId: string | undefined, delta: number) {
			await adjustVolume(playerId, delta)
		},
		async setMute(playerId: string | undefined, muted: boolean) {
			await setMute(playerId, muted)
		},
		async listFavorites(playerId?: string) {
			return await listFavorites(playerId)
		},
		async searchFavorites(query: string, playerId?: string) {
			return await searchFavorites(query, playerId)
		},
		async playFavorite(inputArgs: {
			playerId?: string
			favoriteId?: string
			title?: string
		}) {
			return await playFavorite(inputArgs)
		},
		async enqueueFavorite(inputArgs: {
			playerId?: string
			favoriteId?: string
			title?: string
		}) {
			return await enqueueFavorite(inputArgs)
		},
		async listSavedQueues(playerId?: string) {
			return await listSavedQueues(playerId)
		},
		async searchSavedQueues(query: string, playerId?: string) {
			return await searchSavedQueues(query, playerId)
		},
		async playSavedQueue(inputArgs: {
			playerId?: string
			savedQueueId?: string
			title?: string
		}) {
			return await playSavedQueue(inputArgs)
		},
		async enqueueSavedQueue(inputArgs: {
			playerId?: string
			savedQueueId?: string
			title?: string
		}) {
			return await enqueueSavedQueue(inputArgs)
		},
		async listQueue(playerId?: string) {
			return await listQueue(playerId)
		},
		async clearQueue(playerId?: string) {
			await clearQueue(playerId)
		},
		async removeQueueTrack(inputArgs: {
			playerId?: string
			queueItemId?: string
			position?: number
		}) {
			await removeQueueTrack(inputArgs)
		},
		async groupPlayers(inputArgs: {
			playerId: string
			coordinatorPlayerId: string
		}) {
			await groupPlayers(inputArgs)
		},
		async ungroupPlayer(playerId: string) {
			await ungroupPlayer(playerId)
		},
		async getAudioInput(playerId?: string) {
			return await getAudioInput(playerId)
		},
		async selectAudioInput(playerId?: string) {
			await selectAudioInput(playerId)
		},
		async setLineInLevel(
			playerId: string | undefined,
			leftLevel: number,
			rightLevel: number,
		) {
			await setLineInLevel(playerId, leftLevel, rightLevel)
		},
		async startLineInToGroup(inputArgs: {
			sourcePlayerId: string
			coordinatorPlayerId: string
		}) {
			await startLineInToGroup(inputArgs)
		},
		async stopLineInToGroup(inputArgs: {
			sourcePlayerId: string
			coordinatorPlayerId: string
		}) {
			await stopLineInToGroup(inputArgs)
		},
		async searchLocalLibrary(inputArgs: {
			query: string
			playerId?: string
			category?: SonosLibraryCategory
			limit?: number
		}) {
			return await searchLocalLibrary(inputArgs)
		},
		async listLibraryArtists(
			playerId?: string,
			query?: string,
			limit?: number,
		) {
			return await listLibraryEntries({
				playerId,
				category: 'artists',
				query,
				limit,
			})
		},
		async listLibraryAlbums(playerId?: string, query?: string, limit?: number) {
			return await listLibraryEntries({
				playerId,
				category: 'albums',
				query,
				limit,
			})
		},
		async listLibraryTracks(playerId?: string, query?: string, limit?: number) {
			return await listLibraryEntries({
				playerId,
				category: 'tracks',
				query,
				limit,
			})
		},
		async playUri(inputArgs: {
			playerId?: string
			uri: string
			metadata?: string
			title?: string | null
			artist?: string | null
			album?: string | null
		}) {
			await playUri(inputArgs)
		},
		async setBass(playerId: string | undefined, bass: number) {
			await setBass(playerId, bass)
		},
		async setTreble(playerId: string | undefined, treble: number) {
			await setTreble(playerId, treble)
		},
		async setLoudness(playerId: string | undefined, loudness: boolean) {
			await setLoudness(playerId, loudness)
		},
	}
}
