import {
	type SonosAudioInputStatus,
	type SonosDidlEntry,
	type SonosGroup,
	type SonosGroupMember,
	type SonosLibraryCategory,
	type SonosPersistedPlayer,
	type SonosQueueTrack,
} from './types.ts'

const sonosSoapTimeoutMs = 10_000

function buildSoapEnvelope(body: string) {
	return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
	<s:Body>${body}</s:Body>
</s:Envelope>`
}

function isTimeoutError(error: unknown) {
	return (
		error instanceof Error &&
		(error.name === 'TimeoutError' || error.name === 'AbortError')
	)
}

export function stripSonosUuidPrefix(udn: string) {
	return udn.replace(/^uuid:/i, '')
}

export function encodeXml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

export function decodeXmlEntities(value: string) {
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&')
}

function extractTag(xml: string, tagName: string) {
	const match = xml.match(
		new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'),
	)
	return match?.[1] ?? null
}

function extractTitleFromMetadata(metadata: string | null) {
	if (!metadata) return null
	return (
		decodeXmlEntities(metadata).match(
			/<dc:title>([\s\S]*?)<\/dc:title>/,
		)?.[1] ?? null
	)
}

function extractArtistFromMetadata(metadata: string | null) {
	if (!metadata) return null
	return (
		decodeXmlEntities(metadata).match(
			/<dc:creator>([\s\S]*?)<\/dc:creator>/,
		)?.[1] ?? null
	)
}

function extractAlbumFromMetadata(metadata: string | null) {
	if (!metadata) return null
	return (
		decodeXmlEntities(metadata).match(
			/<upnp:album>([\s\S]*?)<\/upnp:album>/,
		)?.[1] ?? null
	)
}

async function soapRequest(input: {
	host: string
	path: string
	serviceType: string
	action: string
	body: string
}) {
	const url = `http://${input.host}:1400${input.path}`
	let response: Response
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml; charset="utf-8"',
				SOAPAction: `${input.serviceType}#${input.action}`,
			},
			body: buildSoapEnvelope(input.body),
			signal: AbortSignal.timeout(sonosSoapTimeoutMs),
		})
	} catch (error) {
		if (isTimeoutError(error)) {
			throw new Error(
				`Sonos ${input.action} timed out after ${sonosSoapTimeoutMs}ms for ${url}`,
			)
		}
		throw error
	}
	const text = await response.text()
	if (!response.ok) {
		throw new Error(
			`Sonos ${input.action} failed (${response.status}) for ${url}: ${text}`,
		)
	}
	return text
}

function avTransport(host: string, action: string, body: string) {
	return soapRequest({
		host,
		path: '/MediaRenderer/AVTransport/Control',
		serviceType: 'urn:schemas-upnp-org:service:AVTransport:1',
		action,
		body,
	})
}

function renderingControl(host: string, action: string, body: string) {
	return soapRequest({
		host,
		path: '/MediaRenderer/RenderingControl/Control',
		serviceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
		action,
		body,
	})
}

function contentDirectory(host: string, action: string, body: string) {
	return soapRequest({
		host,
		path: '/MediaServer/ContentDirectory/Control',
		serviceType: 'urn:schemas-upnp-org:service:ContentDirectory:1',
		action,
		body,
	})
}

function zoneGroupTopology(host: string, action: string, body: string) {
	return soapRequest({
		host,
		path: '/ZoneGroupTopology/Control',
		serviceType: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
		action,
		body,
	})
}

function audioIn(host: string, action: string, body: string) {
	return soapRequest({
		host,
		path: '/AudioIn/Control',
		serviceType: 'urn:schemas-upnp-org:service:AudioIn:1',
		action,
		body,
	})
}

function parseDidlEntries(encodedResult: string): Array<SonosDidlEntry> {
	const xml = decodeXmlEntities(encodedResult)
	const entries: Array<SonosDidlEntry> = []
	const itemRegex = /<(item|container)\b([^>]*)>([\s\S]*?)<\/\1>/g
	for (const match of xml.matchAll(itemRegex)) {
		const [, kind, attrs, inner] = match
		const id = attrs.match(/\bid="([^"]*)"/)?.[1] ?? null
		const parentId = attrs.match(/\bparentID="([^"]*)"/)?.[1] ?? null
		const title = inner.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1] ?? null
		const className =
			inner.match(/<upnp:class>([\s\S]*?)<\/upnp:class>/)?.[1] ?? null
		const artist =
			inner.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1] ?? null
		const album =
			inner.match(/<upnp:album>([\s\S]*?)<\/upnp:album>/)?.[1] ?? null
		const uri =
			inner.match(/<res(?:\s[^>]*)?>([\s\S]*?)<\/res>/)?.[1]?.trim() ?? null
		const metadata =
			decodeXmlEntities(
				inner.match(/<r:resMD>([\s\S]*?)<\/r:resMD>/)?.[1] ?? '',
			) || null
		const provider =
			inner.match(/<r:description>([\s\S]*?)<\/r:description>/)?.[1] ?? null
		const playbackType =
			inner.match(/<r:type>([\s\S]*?)<\/r:type>/)?.[1] ?? null
		entries.push({
			kind: kind === 'container' ? 'container' : 'item',
			id,
			parentId,
			title,
			className,
			artist,
			album,
			uri,
			metadata,
			provider,
			playbackType,
			isPlayable: Boolean(uri),
		})
	}
	return entries
}

function buildLibraryObjectId(category: SonosLibraryCategory) {
	switch (category) {
		case 'artists':
			return 'A:ALBUMARTIST'
		case 'albums':
			return 'A:ALBUM'
		case 'tracks':
			return 'A:TRACKS'
	}
}

function buildSearchObjectId(objectId: string, query: string) {
	const encodedQuery = encodeURIComponent(query.trim()).replaceAll('%20', '+')
	return `${objectId}:search+${encodedQuery}`
}

export async function browseSonosContent(input: {
	host: string
	objectId: string
	requestedCount?: number
	startingIndex?: number
}) {
	const requestedCount = input.requestedCount ?? 100
	const startingIndex = input.startingIndex ?? 0
	const xml = await contentDirectory(
		input.host,
		'Browse',
		`<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>${encodeXml(input.objectId)}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>${startingIndex}</StartingIndex><RequestedCount>${requestedCount}</RequestedCount><SortCriteria></SortCriteria></u:Browse>`,
	)
	return {
		totalMatches: Number(extractTag(xml, 'TotalMatches') ?? '0'),
		numberReturned: Number(extractTag(xml, 'NumberReturned') ?? '0'),
		items: parseDidlEntries(extractTag(xml, 'Result') ?? ''),
	}
}

export async function browseAllSonosContent(input: {
	host: string
	objectId: string
	limit?: number
}) {
	const limit = input.limit ?? 1_000
	let startingIndex = 0
	let items: Array<SonosDidlEntry> = []
	while (items.length < limit) {
		const page = await browseSonosContent({
			host: input.host,
			objectId: input.objectId,
			requestedCount: Math.min(100, limit - items.length),
			startingIndex,
		})
		items = [...items, ...page.items]
		if (items.length >= page.totalMatches || page.numberReturned === 0) {
			break
		}
		startingIndex += page.numberReturned
	}
	return items
}

export async function listSonosFavoritesLive(host: string) {
	return (await browseAllSonosContent({ host, objectId: 'FV:2' })).map(
		(entry) => ({
			...entry,
			favoriteId: entry.id ?? '',
		}),
	)
}

export async function listSonosSavedQueuesLive(host: string) {
	return (await browseAllSonosContent({ host, objectId: 'SQ:' })).map(
		(entry) => ({
			...entry,
			savedQueueId: entry.id ?? '',
		}),
	)
}

export async function listSonosQueueLive(input: {
	host: string
	player: SonosPersistedPlayer
}) {
	const items = await browseAllSonosContent({
		host: input.host,
		objectId: 'Q:0',
	})
	return items.map((entry, index) => ({
		...entry,
		queueItemId: entry.id ?? `Q:0/${index + 1}`,
		position: index + 1,
	})) satisfies Array<SonosQueueTrack>
}

export async function listSonosLibraryEntriesLive(input: {
	host: string
	category: SonosLibraryCategory
	query?: string
	limit?: number
}) {
	const objectId = buildLibraryObjectId(input.category)
	return await browseAllSonosContent({
		host: input.host,
		objectId:
			input.query && input.query.trim()
				? buildSearchObjectId(objectId, input.query)
				: objectId,
		limit: input.limit,
	})
}

export async function searchSonosLocalLibraryLive(input: {
	host: string
	query: string
	category?: SonosLibraryCategory
	limit?: number
}) {
	const categories: Array<SonosLibraryCategory> = input.category
		? [input.category]
		: ['artists', 'albums', 'tracks']
	return await Promise.all(
		categories.map(async (category) => ({
			category,
			entries: await listSonosLibraryEntriesLive({
				host: input.host,
				category,
				query: input.query,
				limit: input.limit,
			}),
		})),
	)
}

export async function getSonosGroupsLive(input: {
	host: string
	players: Array<SonosPersistedPlayer>
}) {
	const xml = await zoneGroupTopology(
		input.host,
		'GetZoneGroupState',
		'<u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState>',
	)
	const encodedState = extractTag(xml, 'ZoneGroupState') ?? ''
	const groupStateXml = decodeXmlEntities(encodedState)
	const groups: Array<SonosGroup> = []
	const groupRegex =
		/<ZoneGroup Coordinator="([^"]+)" ID="([^"]+)">([\s\S]*?)<\/ZoneGroup>/g
	const memberRegex =
		/<ZoneGroupMember[^>]*UUID="([^"]+)"[^>]*Location="([^"]+)"[^>]*ZoneName="([^"]+)"/g
	for (const match of groupStateXml.matchAll(groupRegex)) {
		const [, coordinatorId, groupId, membersXml] = match
		const members: Array<SonosGroupMember> = []
		for (const memberMatch of membersXml.matchAll(memberRegex)) {
			const [, memberUdn, location, roomName] = memberMatch
			const player =
				input.players.find(
					(entry) =>
						stripSonosUuidPrefix(entry.udn) === memberUdn ||
						entry.udn === memberUdn ||
						entry.descriptionUrl === location,
				) ?? null
			members.push({
				playerId:
					player?.playerId ??
					`sonos-${memberUdn.replaceAll(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`,
				udn: memberUdn.startsWith('uuid:') ? memberUdn : `uuid:${memberUdn}`,
				roomName,
				host: player?.host ?? new URL(location).hostname,
				coordinator: memberUdn === coordinatorId,
				audioInputSupported: player?.audioInputSupported ?? false,
			})
		}
		groups.push({
			groupId,
			coordinatorId,
			coordinatorPlayerId:
				members.find((member) => member.coordinator)?.playerId ?? null,
			members,
		})
	}
	return groups
}

export async function getSonosTransportInfoLive(host: string) {
	const xml = await avTransport(
		host,
		'GetTransportInfo',
		'<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>',
	)
	return {
		transportState: extractTag(xml, 'CurrentTransportState'),
		transportStatus: extractTag(xml, 'CurrentTransportStatus'),
	}
}

export async function getSonosMediaInfoLive(host: string) {
	const xml = await avTransport(
		host,
		'GetMediaInfo',
		'<u:GetMediaInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetMediaInfo>',
	)
	return {
		currentUri: extractTag(xml, 'CurrentURI'),
		queueLength: Number(extractTag(xml, 'NrTracks') ?? '0'),
	}
}

export async function getSonosPositionInfoLive(host: string) {
	const xml = await avTransport(
		host,
		'GetPositionInfo',
		'<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>',
	)
	const metadata = extractTag(xml, 'TrackMetaData')
	return {
		track: Number(extractTag(xml, 'Track') ?? '0'),
		trackUri: extractTag(xml, 'TrackURI'),
		trackTitle: extractTitleFromMetadata(metadata),
		trackArtist: extractArtistFromMetadata(metadata),
		trackAlbum: extractAlbumFromMetadata(metadata),
		trackPosition: extractTag(xml, 'RelTime'),
	}
}

export async function getSonosVolumeLive(host: string) {
	const xml = await renderingControl(
		host,
		'GetVolume',
		'<u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>',
	)
	return Number(extractTag(xml, 'CurrentVolume') ?? '0')
}

export async function setSonosVolumeLive(host: string, volume: number) {
	await renderingControl(
		host,
		'SetVolume',
		`<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${volume}</DesiredVolume></u:SetVolume>`,
	)
}

export async function setSonosRelativeVolumeLive(
	host: string,
	adjustment: number,
) {
	await renderingControl(
		host,
		'SetRelativeVolume',
		`<u:SetRelativeVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><Adjustment>${adjustment}</Adjustment></u:SetRelativeVolume>`,
	)
}

export async function getSonosMuteLive(host: string) {
	const xml = await renderingControl(
		host,
		'GetMute',
		'<u:GetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetMute>',
	)
	return extractTag(xml, 'CurrentMute') === '1'
}

export async function setSonosMuteLive(host: string, muted: boolean) {
	await renderingControl(
		host,
		'SetMute',
		`<u:SetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${muted ? 1 : 0}</DesiredMute></u:SetMute>`,
	)
}

export async function getSonosBassLive(host: string) {
	const xml = await renderingControl(
		host,
		'GetBass',
		'<u:GetBass xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetBass>',
	)
	return Number(extractTag(xml, 'CurrentBass') ?? '0')
}

export async function setSonosBassLive(host: string, bass: number) {
	await renderingControl(
		host,
		'SetBass',
		`<u:SetBass xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><DesiredBass>${bass}</DesiredBass></u:SetBass>`,
	)
}

export async function getSonosTrebleLive(host: string) {
	const xml = await renderingControl(
		host,
		'GetTreble',
		'<u:GetTreble xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID></u:GetTreble>',
	)
	return Number(extractTag(xml, 'CurrentTreble') ?? '0')
}

export async function setSonosTrebleLive(host: string, treble: number) {
	await renderingControl(
		host,
		'SetTreble',
		`<u:SetTreble xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><DesiredTreble>${treble}</DesiredTreble></u:SetTreble>`,
	)
}

export async function getSonosLoudnessLive(host: string) {
	const xml = await renderingControl(
		host,
		'GetLoudness',
		'<u:GetLoudness xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetLoudness>',
	)
	return extractTag(xml, 'CurrentLoudness') === '1'
}

export async function setSonosLoudnessLive(host: string, loudness: boolean) {
	await renderingControl(
		host,
		'SetLoudness',
		`<u:SetLoudness xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredLoudness>${loudness ? 1 : 0}</DesiredLoudness></u:SetLoudness>`,
	)
}

export async function clearSonosQueueLive(host: string) {
	await avTransport(
		host,
		'RemoveAllTracksFromQueue',
		'<u:RemoveAllTracksFromQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>',
	)
}

export async function removeSonosQueueTrackLive(
	host: string,
	objectId: string,
) {
	await avTransport(
		host,
		'RemoveTrackFromQueue',
		`<u:RemoveTrackFromQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><ObjectID>${encodeXml(objectId)}</ObjectID><UpdateID>0</UpdateID></u:RemoveTrackFromQueue>`,
	)
}

export async function addSonosUriToQueueLive(input: {
	host: string
	uri: string
	metadata?: string | null
}) {
	const xml = await avTransport(
		input.host,
		'AddURIToQueue',
		`<u:AddURIToQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><EnqueuedURI>${encodeXml(input.uri)}</EnqueuedURI><EnqueuedURIMetaData>${encodeXml(input.metadata ?? '')}</EnqueuedURIMetaData><DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued><EnqueueAsNext>0</EnqueueAsNext></u:AddURIToQueue>`,
	)
	return {
		firstTrackNumberEnqueued: Number(
			extractTag(xml, 'FirstTrackNumberEnqueued') ?? '0',
		),
		numTracksAdded: Number(extractTag(xml, 'NumTracksAdded') ?? '0'),
		newQueueLength: Number(extractTag(xml, 'NewQueueLength') ?? '0'),
	}
}

export async function setSonosTransportUriLive(input: {
	host: string
	uri: string
	metadata?: string | null
}) {
	await avTransport(
		input.host,
		'SetAVTransportURI',
		`<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>${encodeXml(input.uri)}</CurrentURI><CurrentURIMetaData>${encodeXml(input.metadata ?? '')}</CurrentURIMetaData></u:SetAVTransportURI>`,
	)
}

export async function playSonosLive(host: string) {
	await avTransport(
		host,
		'Play',
		'<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>',
	)
}

export async function pauseSonosLive(host: string) {
	await avTransport(
		host,
		'Pause',
		'<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Pause>',
	)
}

export async function stopSonosLive(host: string) {
	await avTransport(
		host,
		'Stop',
		'<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Stop>',
	)
}

export async function nextSonosTrackLive(host: string) {
	await avTransport(
		host,
		'Next',
		'<u:Next xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Next>',
	)
}

export async function previousSonosTrackLive(host: string) {
	await avTransport(
		host,
		'Previous',
		'<u:Previous xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Previous>',
	)
}

export async function seekSonosTrackLive(host: string, position: string) {
	await avTransport(
		host,
		'Seek',
		`<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${encodeXml(position)}</Target></u:Seek>`,
	)
}

export async function setSonosPlayModeLive(host: string, playMode: string) {
	await avTransport(
		host,
		'SetPlayMode',
		`<u:SetPlayMode xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><NewPlayMode>${encodeXml(playMode)}</NewPlayMode></u:SetPlayMode>`,
	)
}

export async function groupSonosPlayerLive(input: {
	host: string
	coordinatorUdn: string
}) {
	await setSonosTransportUriLive({
		host: input.host,
		uri: `x-rincon:${stripSonosUuidPrefix(input.coordinatorUdn)}`,
	})
}

export async function ungroupSonosPlayerLive(host: string) {
	await avTransport(
		host,
		'BecomeCoordinatorOfStandaloneGroup',
		'<u:BecomeCoordinatorOfStandaloneGroup xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:BecomeCoordinatorOfStandaloneGroup>',
	)
}

export async function getSonosAudioInputLive(input: {
	host: string
	player: SonosPersistedPlayer
}) {
	if (!input.player.audioInputSupported) {
		return {
			supported: false,
			name: null,
			icon: null,
			leftLevel: null,
			rightLevel: null,
			lineInUri: null,
		} satisfies SonosAudioInputStatus
	}
	const attributesXml = await audioIn(
		input.host,
		'GetAudioInputAttributes',
		'<u:GetAudioInputAttributes xmlns:u="urn:schemas-upnp-org:service:AudioIn:1"></u:GetAudioInputAttributes>',
	)
	const lineLevelXml = await audioIn(
		input.host,
		'GetLineInLevel',
		'<u:GetLineInLevel xmlns:u="urn:schemas-upnp-org:service:AudioIn:1"></u:GetLineInLevel>',
	)
	return {
		supported: true,
		name: extractTag(attributesXml, 'CurrentName'),
		icon: extractTag(attributesXml, 'CurrentIcon'),
		leftLevel: Number(
			extractTag(lineLevelXml, 'CurrentLeftLineInLevel') ?? '0',
		),
		rightLevel: Number(
			extractTag(lineLevelXml, 'CurrentRightLineInLevel') ?? '0',
		),
		lineInUri: `x-rincon-stream:${stripSonosUuidPrefix(input.player.udn)}`,
	} satisfies SonosAudioInputStatus
}

export async function selectSonosAudioInputLive(input: {
	host: string
	player: SonosPersistedPlayer
}) {
	await setSonosTransportUriLive({
		host: input.host,
		uri: `x-rincon-stream:${stripSonosUuidPrefix(input.player.udn)}`,
	})
	await playSonosLive(input.host)
}

export async function setSonosLineInLevelLive(input: {
	host: string
	leftLevel: number
	rightLevel: number
}) {
	await audioIn(
		input.host,
		'SetLineInLevel',
		`<u:SetLineInLevel xmlns:u="urn:schemas-upnp-org:service:AudioIn:1"><DesiredLeftLineInLevel>${input.leftLevel}</DesiredLeftLineInLevel><DesiredRightLineInLevel>${input.rightLevel}</DesiredRightLineInLevel></u:SetLineInLevel>`,
	)
}

export async function startSonosLineInToGroupLive(input: {
	host: string
	coordinatorUdn: string
}) {
	await audioIn(
		input.host,
		'StartTransmissionToGroup',
		`<u:StartTransmissionToGroup xmlns:u="urn:schemas-upnp-org:service:AudioIn:1"><CoordinatorID>${encodeXml(stripSonosUuidPrefix(input.coordinatorUdn))}</CoordinatorID></u:StartTransmissionToGroup>`,
	)
}

export async function stopSonosLineInToGroupLive(input: {
	host: string
	coordinatorUdn: string
}) {
	await audioIn(
		input.host,
		'StopTransmissionToGroup',
		`<u:StopTransmissionToGroup xmlns:u="urn:schemas-upnp-org:service:AudioIn:1"><CoordinatorID>${encodeXml(stripSonosUuidPrefix(input.coordinatorUdn))}</CoordinatorID></u:StopTransmissionToGroup>`,
	)
}

export async function enqueueSonosEntryIntoQueueLive(input: {
	host: string
	entry: SonosDidlEntry
}) {
	if (input.entry.uri) {
		return await addSonosUriToQueueLive({
			host: input.host,
			uri: input.entry.uri,
			metadata: input.entry.metadata,
		})
	}
	if (!input.entry.id) {
		throw new Error('Sonos entry does not contain a playable URI or object id.')
	}
	const childEntries = await browseAllSonosContent({
		host: input.host,
		objectId: input.entry.id,
	})
	let added = 0
	for (const childEntry of childEntries) {
		if (!childEntry.uri) continue
		const result = await addSonosUriToQueueLive({
			host: input.host,
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
