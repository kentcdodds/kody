import {
	type SonosAudioInputStatus,
	type SonosDidlEntry,
	type SonosFavorite,
	type SonosGroup,
	type SonosGroupMember,
	type SonosGroupStatus,
	type SonosLibraryCategory,
	type SonosLibrarySearchResult,
	type SonosPersistedPlayer,
	type SonosPlayerRecord,
	type SonosPlayerStatus,
	type SonosQueueTrack,
	type SonosSavedQueue,
} from './types.ts'

type MockQueueTrack = SonosQueueTrack

type MockPlayerState = {
	player: SonosPersistedPlayer
	transportState: string
	transportStatus: string
	volume: number
	muted: boolean
	bass: number
	treble: number
	loudness: boolean
	queue: Array<MockQueueTrack>
	currentTrackIndex: number | null
	playMode: string
	audioInput: SonosAudioInputStatus
	currentUri: string | null
}

type MockFavoriteSeed = {
	title: string
	provider: string
	uri: string
	metadata: string
	tracks: Array<{
		title: string
		artist: string
		album: string
		uri: string
	}>
}

type MockSavedQueueSeed = {
	title: string
	res: string
	tracks: Array<{
		title: string
		artist: string
		album: string
		uri: string
	}>
}

const basePlayers: Array<SonosPlayerRecord> = [
	{
		playerId: 'sonos-office-speakers',
		udn: 'uuid:RINCON_MOCK_OFFICE_01400',
		roomName: 'Office Speakers',
		displayName: 'Amp',
		friendlyName: '192.168.1.112 - Sonos Amp - RINCON_MOCK_OFFICE_01400',
		modelName: 'Sonos Amp',
		modelNumber: 'S16',
		serialNum: '80-4A-F2-A8-DB-22:0',
		householdId: 'Sonos_MockHousehold',
		host: 'office-sonos.mock.local',
		descriptionUrl:
			'http://office-sonos.mock.local:1400/xml/device_description.xml',
		audioInputSupported: true,
		adopted: false,
		lastSeenAt: '2026-04-08T21:32:51.028Z',
		rawDescriptionXml: null,
	},
	{
		playerId: 'sonos-gym',
		udn: 'uuid:RINCON_MOCK_GYM_01400',
		roomName: 'Gym',
		displayName: 'Amp',
		friendlyName: '192.168.1.140 - Sonos Amp - RINCON_MOCK_GYM_01400',
		modelName: 'Sonos Amp',
		modelNumber: 'S16',
		serialNum: '80-4A-F2-AA-96-14:4',
		householdId: 'Sonos_MockHousehold',
		host: 'gym-sonos.mock.local',
		descriptionUrl:
			'http://gym-sonos.mock.local:1400/xml/device_description.xml',
		audioInputSupported: true,
		adopted: false,
		lastSeenAt: '2026-04-08T21:32:51.028Z',
		rawDescriptionXml: null,
	},
]

const mockFavoriteSeeds: Array<MockFavoriteSeed> = [
	{
		title: 'Relaxing Piano Broadway Mix',
		provider: 'Spotify',
		uri: 'x-rincon-cpcontainer:mock-relaxing-piano-broadway-mix',
		metadata:
			'<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="mock-relaxing-piano-broadway-mix" parentID="mock-relaxing-piano-broadway-mix" restricted="true"><dc:title>Relaxing Piano Broadway Mix</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON3079_X_#Svc3079-mock</desc></item></DIDL-Lite>',
		tracks: [
			{
				title: 'Engagement Party',
				artist: 'The Piano Players',
				album: 'Relaxing Piano Broadway Mix',
				uri: 'x-sonos-spotify:track-engagement-party',
			},
			{
				title: 'On My Own',
				artist: 'The Piano Players',
				album: 'Relaxing Piano Broadway Mix',
				uri: 'x-sonos-spotify:track-on-my-own',
			},
		],
	},
	{
		title: 'Upbeat Dance Mix',
		provider: 'Spotify',
		uri: 'x-rincon-cpcontainer:mock-upbeat-dance-mix',
		metadata:
			'<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="mock-upbeat-dance-mix" parentID="mock-upbeat-dance-mix" restricted="true"><dc:title>Upbeat Dance Mix</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON3079_X_#Svc3079-mock</desc></item></DIDL-Lite>',
		tracks: [
			{
				title: 'Hit the Lights',
				artist: 'Dance Unit',
				album: 'Upbeat Dance Mix',
				uri: 'x-sonos-spotify:track-hit-the-lights',
			},
		],
	},
]

const mockSavedQueueSeeds: Array<MockSavedQueueSeed> = [
	{
		title: 'Church',
		res: 'file:///jffs/settings/savedqueues.rsq#0',
		tracks: [
			{
				title: 'Abide with Me',
				artist: 'Choir',
				album: 'Church',
				uri: 'x-sonos-spotify:track-abide-with-me',
			},
			{
				title: 'Come Thou Fount',
				artist: 'Choir',
				album: 'Church',
				uri: 'x-sonos-spotify:track-come-thou-fount',
			},
		],
	},
	{
		title: 'Livingstone',
		res: 'file:///jffs/settings/savedqueues.rsq#2',
		tracks: [
			{
				title: 'Livingstone',
				artist: 'Family Mix',
				album: 'Livingstone',
				uri: 'x-sonos-spotify:track-livingstone',
			},
		],
	},
]

const mockLibraryEntries: Record<
	SonosLibraryCategory,
	Array<SonosDidlEntry>
> = {
	artists: [
		{
			kind: 'container',
			id: 'A:ALBUMARTIST:artist:1',
			parentId: 'A:ALBUMARTIST',
			title: 'The Piano Guys',
			className: 'object.container.person.musicArtist',
			artist: 'The Piano Guys',
			album: null,
			uri: null,
			metadata: null,
			provider: 'Music Library',
			playbackType: null,
			isPlayable: false,
		},
	],
	albums: [
		{
			kind: 'container',
			id: 'A:ALBUM:album:1',
			parentId: 'A:ALBUM',
			title: 'Broadway Piano Covers',
			className: 'object.container.album.musicAlbum',
			artist: 'The Piano Players',
			album: 'Broadway Piano Covers',
			uri: 'x-rincon-cpcontainer:library-broadway-piano-covers',
			metadata:
				'<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="library-broadway-piano-covers" parentID="library-broadway-piano-covers" restricted="true"><dc:title>Broadway Piano Covers</dc:title><upnp:class>object.container.album.musicAlbum</upnp:class></item></DIDL-Lite>',
			provider: 'Music Library',
			playbackType: 'instantPlay',
			isPlayable: true,
		},
	],
	tracks: [
		{
			kind: 'item',
			id: 'A:TRACKS:track:1',
			parentId: 'A:TRACKS',
			title: 'Engagement Party',
			className: 'object.item.audioItem.musicTrack',
			artist: 'The Piano Players',
			album: 'Relaxing Piano Broadway Mix',
			uri: 'x-sonos-spotify:track-engagement-party',
			metadata:
				'<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="track-engagement-party" parentID="track-engagement-party" restricted="true"><dc:title>Engagement Party</dc:title><dc:creator>The Piano Players</dc:creator><upnp:album>Relaxing Piano Broadway Mix</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class></item></DIDL-Lite>',
			provider: 'Music Library',
			playbackType: 'instantPlay',
			isPlayable: true,
		},
	],
}

const mockState = {
	players: new Map<string, MockPlayerState>(),
	groups: new Map<
		string,
		{
			groupId: string
			coordinatorPlayerId: string
			memberPlayerIds: Array<string>
		}
	>(),
}

function stripUuidPrefix(udn: string) {
	return udn.replace(/^uuid:/i, '')
}

function createMockQueueTrack(input: {
	position: number
	title: string
	artist: string
	album: string
	uri: string
	metadata?: string | null
}) {
	return {
		kind: 'item',
		id: `Q:0/${input.position}`,
		parentId: 'Q:0',
		title: input.title,
		className: 'object.item.audioItem.musicTrack',
		artist: input.artist,
		album: input.album,
		uri: input.uri,
		metadata: input.metadata ?? null,
		provider: 'Queue',
		playbackType: 'queue',
		isPlayable: true,
		queueItemId: `Q:0/${input.position}`,
		position: input.position,
	} satisfies MockQueueTrack
}

function rebuildQueueIds(queue: Array<MockQueueTrack>) {
	return queue.map((track, index) =>
		createMockQueueTrack({
			position: index + 1,
			title: track.title ?? 'Unknown track',
			artist: track.artist ?? 'Unknown artist',
			album: track.album ?? 'Unknown album',
			uri: track.uri ?? `x-sonos-mock:track:${index.toString(10)}`,
			metadata: track.metadata,
		}),
	)
}

function getPlayerState(playerId: string) {
	const player = mockState.players.get(playerId)
	if (!player) {
		throw new Error(`Mock Sonos player "${playerId}" was not found.`)
	}
	return player
}

function getGroupRecordForPlayer(playerId: string) {
	return (
		[...mockState.groups.values()].find((group) =>
			group.memberPlayerIds.includes(playerId),
		) ?? null
	)
}

function getCoordinatorState(playerId: string) {
	const group = getGroupRecordForPlayer(playerId)
	if (!group) return getPlayerState(playerId)
	return getPlayerState(group.coordinatorPlayerId)
}

function createGroup(group: {
	groupId: string
	coordinatorPlayerId: string
	memberPlayerIds: Array<string>
}): SonosGroup {
	return {
		groupId: group.groupId,
		coordinatorId: stripUuidPrefix(
			getPlayerState(group.coordinatorPlayerId).player.udn,
		),
		coordinatorPlayerId: group.coordinatorPlayerId,
		members: group.memberPlayerIds.map((playerId) => {
			const player = getPlayerState(playerId).player
			return {
				playerId: player.playerId,
				udn: player.udn,
				roomName: player.roomName,
				host: player.host,
				coordinator: playerId === group.coordinatorPlayerId,
				audioInputSupported: player.audioInputSupported,
			} satisfies SonosGroupMember
		}),
	}
}

function createFavorite(index: number, seed: MockFavoriteSeed): SonosFavorite {
	return {
		kind: 'item',
		id: `FV:2/${index + 1}`,
		parentId: 'FV:2',
		title: seed.title,
		className: 'object.itemobject.item.sonos-favorite',
		artist: null,
		album: null,
		uri: seed.uri,
		metadata: seed.metadata,
		provider: seed.provider,
		playbackType: 'instantPlay',
		isPlayable: true,
		favoriteId: `FV:2/${index + 1}`,
	}
}

function createSavedQueue(
	index: number,
	seed: MockSavedQueueSeed,
): SonosSavedQueue {
	return {
		kind: 'container',
		id: `SQ:${index}`,
		parentId: 'SQ:',
		title: seed.title,
		className: 'object.container.playlistContainer',
		artist: null,
		album: null,
		uri: seed.res,
		metadata: null,
		provider: 'Saved Queue',
		playbackType: 'queue',
		isPlayable: true,
		savedQueueId: `SQ:${index}`,
	}
}

function searchEntries<T extends { title: string | null }>(
	entries: Array<T>,
	query: string,
) {
	const normalizedQuery = query.trim().toLowerCase()
	if (!normalizedQuery) return entries
	return entries
		.filter((entry) => entry.title?.toLowerCase().includes(normalizedQuery))
		.sort((left, right) => {
			const leftTitle = left.title?.toLowerCase() ?? ''
			const rightTitle = right.title?.toLowerCase() ?? ''
			const leftStarts = leftTitle.startsWith(normalizedQuery) ? 0 : 1
			const rightStarts = rightTitle.startsWith(normalizedQuery) ? 0 : 1
			return leftStarts - rightStarts || leftTitle.localeCompare(rightTitle)
		})
}

function normalizeMockTitle(value: string | null | undefined) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, ' ')
		.trim()
}

function setQueueAndPlayback(
	playerId: string,
	queueTracks: Array<MockQueueTrack>,
	shouldPlay: boolean,
) {
	const coordinator = getCoordinatorState(playerId)
	coordinator.queue = rebuildQueueIds(queueTracks)
	coordinator.currentTrackIndex = coordinator.queue.length > 0 ? 0 : null
	coordinator.currentUri = `x-rincon-queue:${stripUuidPrefix(coordinator.player.udn)}#0`
	coordinator.transportState =
		shouldPlay && coordinator.queue.length > 0 ? 'PLAYING' : 'STOPPED'
	coordinator.transportStatus = 'OK'
}

function queueTracksFromFavorite(seed: MockFavoriteSeed) {
	return seed.tracks.map((track, index) =>
		createMockQueueTrack({
			position: index + 1,
			title: track.title,
			artist: track.artist,
			album: track.album,
			uri: track.uri,
		}),
	)
}

function queueTracksFromSavedQueue(seed: MockSavedQueueSeed) {
	return seed.tracks.map((track, index) =>
		createMockQueueTrack({
			position: index + 1,
			title: track.title,
			artist: track.artist,
			album: track.album,
			uri: track.uri,
		}),
	)
}

export function resetMockSonosState() {
	mockState.players.clear()
	mockState.groups.clear()
	for (const basePlayer of basePlayers) {
		mockState.players.set(basePlayer.playerId, {
			player: {
				...basePlayer,
			},
			transportState: 'STOPPED',
			transportStatus: 'OK',
			volume: basePlayer.playerId === 'sonos-office-speakers' ? 13 : 18,
			muted: false,
			bass: 0,
			treble: 0,
			loudness: true,
			queue: [],
			currentTrackIndex: null,
			playMode: 'NORMAL',
			audioInput: {
				supported: basePlayer.audioInputSupported,
				name: `${basePlayer.roomName} Line-In`,
				icon: 'line-in',
				leftLevel: 5,
				rightLevel: 5,
				lineInUri: `x-rincon-stream:${stripUuidPrefix(basePlayer.udn)}`,
			},
			currentUri: null,
		})
		mockState.groups.set(basePlayer.playerId, {
			groupId: `${stripUuidPrefix(basePlayer.udn)}:mock-group`,
			coordinatorPlayerId: basePlayer.playerId,
			memberPlayerIds: [basePlayer.playerId],
		})
	}
}

resetMockSonosState()

export function listMockSonosPlayers() {
	return [...mockState.players.values()].map((entry) => ({
		...entry.player,
		adopted: false,
	}))
}

export function listMockSonosGroups() {
	return [...mockState.groups.values()].map(createGroup)
}

export function getMockSonosPlayerStatus(playerId: string): SonosPlayerStatus {
	const playerState = getPlayerState(playerId)
	const coordinator = getCoordinatorState(playerId)
	const groupRecord = getGroupRecordForPlayer(playerId)
	const currentTrack =
		coordinator.currentTrackIndex == null
			? null
			: (coordinator.queue[coordinator.currentTrackIndex] ?? null)
	return {
		player: playerState.player,
		group: groupRecord ? createGroup(groupRecord) : null,
		transportState: coordinator.transportState,
		transportStatus: coordinator.transportStatus,
		currentUri: coordinator.currentUri,
		trackUri: currentTrack?.uri ?? null,
		trackTitle: currentTrack?.title ?? null,
		trackArtist: currentTrack?.artist ?? null,
		trackAlbum: currentTrack?.album ?? null,
		trackPosition: currentTrack ? '0:00:08' : null,
		queueLength: coordinator.queue.length,
		volume: playerState.volume,
		muted: playerState.muted,
		bass: playerState.bass,
		treble: playerState.treble,
		loudness: playerState.loudness,
		audioInput: playerState.audioInput,
	}
}

export function getMockSonosGroupStatus(groupId: string): SonosGroupStatus {
	const groupRecord =
		[...mockState.groups.values()].find((group) => group.groupId === groupId) ??
		null
	if (!groupRecord) {
		throw new Error(`Mock Sonos group "${groupId}" was not found.`)
	}
	const coordinator = getPlayerState(groupRecord.coordinatorPlayerId)
	const currentTrack =
		coordinator.currentTrackIndex == null
			? null
			: (coordinator.queue[coordinator.currentTrackIndex] ?? null)
	return {
		group: createGroup(groupRecord),
		transportState: coordinator.transportState,
		transportStatus: coordinator.transportStatus,
		currentUri: coordinator.currentUri,
		trackUri: currentTrack?.uri ?? null,
		trackTitle: currentTrack?.title ?? null,
		trackArtist: currentTrack?.artist ?? null,
		trackAlbum: currentTrack?.album ?? null,
		trackPosition: currentTrack ? '0:00:08' : null,
		queueLength: coordinator.queue.length,
	}
}

export function listMockSonosFavorites() {
	return mockFavoriteSeeds.map((seed, index) => createFavorite(index, seed))
}

export function searchMockSonosFavorites(query: string) {
	return searchEntries(listMockSonosFavorites(), query)
}

export function listMockSonosSavedQueues() {
	return mockSavedQueueSeeds.map((seed, index) => createSavedQueue(index, seed))
}

export function searchMockSonosSavedQueues(query: string) {
	return searchEntries(listMockSonosSavedQueues(), query)
}

export function listMockSonosQueue(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	return [...coordinator.queue]
}

export function clearMockSonosQueue(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	coordinator.queue = []
	coordinator.currentTrackIndex = null
	coordinator.currentUri = `x-rincon-queue:${stripUuidPrefix(coordinator.player.udn)}#0`
	coordinator.transportState = 'STOPPED'
}

export function removeMockSonosQueueTrack(input: {
	playerId: string
	queueItemId?: string
	position?: number
}) {
	const coordinator = getCoordinatorState(input.playerId)
	const queue = coordinator.queue
	const index =
		typeof input.position === 'number'
			? input.position - 1
			: queue.findIndex((track) => track.queueItemId === input.queueItemId)
	if (index < 0 || index >= queue.length) {
		throw new Error('Mock Sonos queue track was not found.')
	}
	queue.splice(index, 1)
	coordinator.queue = rebuildQueueIds(queue)
	if (!coordinator.queue.length) {
		coordinator.currentTrackIndex = null
		coordinator.transportState = 'STOPPED'
		return
	}
	if (
		coordinator.currentTrackIndex != null &&
		coordinator.currentTrackIndex >= coordinator.queue.length
	) {
		coordinator.currentTrackIndex = coordinator.queue.length - 1
	}
}

export function enqueueMockSonosFavorite(input: {
	playerId: string
	favoriteId?: string
	title?: string
}) {
	const favorite = resolveMockFavorite(input)
	const seed =
		mockFavoriteSeeds[
			listMockSonosFavorites().findIndex(
				(entry) => entry.favoriteId === favorite.favoriteId,
			)
		]
	const coordinator = getCoordinatorState(input.playerId)
	coordinator.queue = rebuildQueueIds([
		...coordinator.queue,
		...queueTracksFromFavorite(seed),
	])
	coordinator.currentUri = `x-rincon-queue:${stripUuidPrefix(coordinator.player.udn)}#0`
	return favorite
}

export function playMockSonosFavorite(input: {
	playerId: string
	favoriteId?: string
	title?: string
}) {
	const favorite = resolveMockFavorite(input)
	const seed =
		mockFavoriteSeeds[
			listMockSonosFavorites().findIndex(
				(entry) => entry.favoriteId === favorite.favoriteId,
			)
		]
	setQueueAndPlayback(input.playerId, queueTracksFromFavorite(seed), true)
	return favorite
}

export function enqueueMockSonosSavedQueue(input: {
	playerId: string
	savedQueueId?: string
	title?: string
}) {
	const savedQueue = resolveMockSavedQueue(input)
	const seed =
		mockSavedQueueSeeds[
			listMockSonosSavedQueues().findIndex(
				(entry) => entry.savedQueueId === savedQueue.savedQueueId,
			)
		]
	const coordinator = getCoordinatorState(input.playerId)
	coordinator.queue = rebuildQueueIds([
		...coordinator.queue,
		...queueTracksFromSavedQueue(seed),
	])
	coordinator.currentUri = `x-rincon-queue:${stripUuidPrefix(coordinator.player.udn)}#0`
	return savedQueue
}

export function playMockSonosSavedQueue(input: {
	playerId: string
	savedQueueId?: string
	title?: string
}) {
	const savedQueue = resolveMockSavedQueue(input)
	const seed =
		mockSavedQueueSeeds[
			listMockSonosSavedQueues().findIndex(
				(entry) => entry.savedQueueId === savedQueue.savedQueueId,
			)
		]
	setQueueAndPlayback(input.playerId, queueTracksFromSavedQueue(seed), true)
	return savedQueue
}

function resolveMockFavorite(input: { favoriteId?: string; title?: string }) {
	const favorites = listMockSonosFavorites()
	if (input.favoriteId) {
		const favorite = favorites.find(
			(entry) => entry.favoriteId === input.favoriteId,
		)
		if (favorite) return favorite
	}
	if (input.title) {
		const normalizedTitle = normalizeMockTitle(input.title)
		const favorite = favorites.find(
			(entry) => normalizeMockTitle(entry.title) === normalizedTitle,
		)
		if (favorite) return favorite
		const fuzzy = searchEntries(favorites, input.title)[0]
		if (fuzzy) return fuzzy
	}
	throw new Error('Mock Sonos favorite was not found.')
}

function resolveMockSavedQueue(input: {
	savedQueueId?: string
	title?: string
}) {
	const savedQueues = listMockSonosSavedQueues()
	if (input.savedQueueId) {
		const savedQueue = savedQueues.find(
			(entry) => entry.savedQueueId === input.savedQueueId,
		)
		if (savedQueue) return savedQueue
	}
	if (input.title) {
		const normalizedTitle = normalizeMockTitle(input.title)
		const savedQueue = savedQueues.find(
			(entry) => normalizeMockTitle(entry.title) === normalizedTitle,
		)
		if (savedQueue) return savedQueue
		const fuzzy = searchEntries(savedQueues, input.title)[0]
		if (fuzzy) return fuzzy
	}
	throw new Error('Mock Sonos saved queue was not found.')
}

export function playMockSonos(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	if (coordinator.queue.length === 0) {
		throw new Error('Mock Sonos queue is empty.')
	}
	coordinator.transportState = 'PLAYING'
	coordinator.transportStatus = 'OK'
}

export function pauseMockSonos(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	coordinator.transportState = 'PAUSED_PLAYBACK'
}

export function stopMockSonos(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	coordinator.transportState = 'STOPPED'
}

export function nextMockSonosTrack(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	if (!coordinator.queue.length) return
	const nextIndex =
		coordinator.currentTrackIndex == null
			? 0
			: Math.min(
					coordinator.currentTrackIndex + 1,
					coordinator.queue.length - 1,
				)
	coordinator.currentTrackIndex = nextIndex
	coordinator.transportState = 'PLAYING'
}

export function previousMockSonosTrack(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	if (!coordinator.queue.length) return
	const previousIndex =
		coordinator.currentTrackIndex == null
			? 0
			: Math.max(coordinator.currentTrackIndex - 1, 0)
	coordinator.currentTrackIndex = previousIndex
	coordinator.transportState = 'PLAYING'
}

export function seekMockSonosTrack(_playerId: string, _position: string) {
	return
}

export function setMockSonosPlayMode(playerId: string, playMode: string) {
	getCoordinatorState(playerId).playMode = playMode
}

export function setMockSonosVolume(playerId: string, volume: number) {
	getPlayerState(playerId).volume = volume
}

export function adjustMockSonosVolume(playerId: string, delta: number) {
	const player = getPlayerState(playerId)
	player.volume = Math.max(0, Math.min(100, player.volume + delta))
}

export function setMockSonosMute(playerId: string, muted: boolean) {
	getPlayerState(playerId).muted = muted
}

export function groupMockSonosPlayers(input: {
	playerId: string
	coordinatorPlayerId: string
}) {
	if (input.playerId === input.coordinatorPlayerId) {
		throw new Error('Player is already the coordinator.')
	}
	const currentGroup = getGroupRecordForPlayer(input.playerId)
	if (currentGroup) {
		currentGroup.memberPlayerIds = currentGroup.memberPlayerIds.filter(
			(memberPlayerId) => memberPlayerId !== input.playerId,
		)
		if (currentGroup.memberPlayerIds.length === 0) {
			mockState.groups.delete(currentGroup.coordinatorPlayerId)
		}
	}
	const targetGroup = getGroupRecordForPlayer(input.coordinatorPlayerId)
	if (!targetGroup) {
		throw new Error('Mock Sonos coordinator group was not found.')
	}
	targetGroup.memberPlayerIds.push(input.playerId)
}

export function ungroupMockSonosPlayer(playerId: string) {
	const currentGroup = getGroupRecordForPlayer(playerId)
	if (!currentGroup || currentGroup.memberPlayerIds.length === 1) return
	currentGroup.memberPlayerIds = currentGroup.memberPlayerIds.filter(
		(memberPlayerId) => memberPlayerId !== playerId,
	)
	const player = getPlayerState(playerId).player
	mockState.groups.set(playerId, {
		groupId: `${stripUuidPrefix(player.udn)}:mock-group`,
		coordinatorPlayerId: playerId,
		memberPlayerIds: [playerId],
	})
}

export function getMockSonosAudioInput(playerId: string) {
	return getPlayerState(playerId).audioInput
}

export function selectMockSonosAudioInput(playerId: string) {
	const coordinator = getCoordinatorState(playerId)
	const player = getPlayerState(playerId)
	coordinator.currentUri = player.audioInput.lineInUri
	coordinator.transportState = 'PLAYING'
}

export function setMockSonosLineInLevel(
	playerId: string,
	leftLevel: number,
	rightLevel: number,
) {
	const player = getPlayerState(playerId)
	player.audioInput.leftLevel = leftLevel
	player.audioInput.rightLevel = rightLevel
}

export function startMockSonosLineInToGroup(input: {
	sourcePlayerId: string
	coordinatorPlayerId: string
}) {
	const coordinator = getCoordinatorState(input.coordinatorPlayerId)
	const source = getPlayerState(input.sourcePlayerId)
	coordinator.currentUri = source.audioInput.lineInUri
	coordinator.transportState = 'PLAYING'
}

export function stopMockSonosLineInToGroup(playerId: string) {
	getCoordinatorState(playerId).transportState = 'STOPPED'
}

export function searchMockSonosLocalLibrary(
	query: string,
	category?: SonosLibraryCategory,
) {
	const categories: Array<SonosLibraryCategory> = category
		? [category]
		: ['artists', 'albums', 'tracks']
	return categories.map((currentCategory) => ({
		category: currentCategory,
		entries: searchEntries(mockLibraryEntries[currentCategory], query),
	})) satisfies Array<SonosLibrarySearchResult>
}

export function listMockSonosLibraryEntries(category: SonosLibraryCategory) {
	return mockLibraryEntries[category]
}

export function playMockSonosUri(input: {
	playerId: string
	uri: string
	title?: string | null
	artist?: string | null
	album?: string | null
}) {
	setQueueAndPlayback(
		input.playerId,
		[
			createMockQueueTrack({
				position: 1,
				title: input.title ?? 'Custom URI',
				artist: input.artist ?? 'Unknown artist',
				album: input.album ?? 'Custom URI',
				uri: input.uri,
			}),
		],
		true,
	)
}

export function setMockSonosBass(playerId: string, bass: number) {
	getPlayerState(playerId).bass = bass
}

export function setMockSonosTreble(playerId: string, treble: number) {
	getPlayerState(playerId).treble = treble
}

export function setMockSonosLoudness(playerId: string, loudness: boolean) {
	getPlayerState(playerId).loudness = loudness
}
