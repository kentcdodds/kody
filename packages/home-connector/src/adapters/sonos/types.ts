export type SonosSsdpHitDiagnostic = {
	receivedAt: string
	remoteAddress: string
	remotePort: number
	raw: string
	location: string | null
	usn: string | null
	server: string | null
	householdId: string | null
}

export type SonosDescriptionLookupDiagnostic = {
	descriptionUrl: string
	host: string | null
	raw: string | null
	parsed: {
		playerId: string | null
		roomName: string | null
		displayName: string | null
		friendlyName: string | null
		modelName: string | null
		modelNumber: string | null
		serialNum: string | null
		householdId: string | null
		audioInputSupported: boolean
	} | null
	error: string | null
}

export type SonosDiscoveryDiagnostics = {
	protocol: 'json' | 'ssdp'
	discoveryUrl: string
	scannedAt: string
	jsonResponse: Record<string, unknown> | null
	ssdpHits: Array<SonosSsdpHitDiagnostic>
	descriptionLookups: Array<SonosDescriptionLookupDiagnostic>
}

export type SonosPlayerRecord = {
	playerId: string
	udn: string
	roomName: string
	displayName: string | null
	friendlyName: string
	modelName: string | null
	modelNumber: string | null
	serialNum: string | null
	householdId: string | null
	host: string
	descriptionUrl: string
	audioInputSupported: boolean
	adopted: boolean
	lastSeenAt: string | null
	rawDescriptionXml: string | null
}

export type SonosPersistedPlayer = SonosPlayerRecord

export type SonosDidlEntry = {
	kind: 'item' | 'container'
	id: string | null
	parentId: string | null
	title: string | null
	className: string | null
	artist: string | null
	album: string | null
	uri: string | null
	metadata: string | null
	provider: string | null
	playbackType: string | null
	isPlayable: boolean
}

export type SonosFavorite = SonosDidlEntry & {
	favoriteId: string
}

export type SonosSavedQueue = SonosDidlEntry & {
	savedQueueId: string
}

export type SonosQueueTrack = SonosDidlEntry & {
	queueItemId: string
	position: number
}

export type SonosGroupMember = {
	playerId: string
	udn: string
	roomName: string
	host: string | null
	coordinator: boolean
	audioInputSupported: boolean
}

export type SonosGroup = {
	groupId: string
	coordinatorId: string
	coordinatorPlayerId: string | null
	members: Array<SonosGroupMember>
}

export type SonosPlayerStatus = {
	player: SonosPersistedPlayer
	group: SonosGroup | null
	transportState: string | null
	transportStatus: string | null
	currentUri: string | null
	trackUri: string | null
	trackTitle: string | null
	trackArtist: string | null
	trackAlbum: string | null
	trackPosition: string | null
	queueLength: number | null
	volume: number | null
	muted: boolean | null
	bass: number | null
	treble: number | null
	loudness: boolean | null
	audioInput: SonosAudioInputStatus | null
}

export type SonosGroupStatus = {
	group: SonosGroup
	transportState: string | null
	transportStatus: string | null
	currentUri: string | null
	trackUri: string | null
	trackTitle: string | null
	trackArtist: string | null
	trackAlbum: string | null
	trackPosition: string | null
	queueLength: number | null
}

export type SonosAudioInputStatus = {
	supported: boolean
	name: string | null
	icon: string | null
	leftLevel: number | null
	rightLevel: number | null
	lineInUri: string | null
}

export type SonosLibraryCategory = 'artists' | 'albums' | 'tracks'

export type SonosLibrarySearchResult = {
	category: SonosLibraryCategory
	entries: Array<SonosDidlEntry>
}
