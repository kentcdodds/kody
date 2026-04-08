import { type HomeConnectorStorage } from '../../storage/index.ts'
import { type SonosPersistedPlayer, type SonosPlayerRecord } from './types.ts'

type SonosPlayerRow = {
	connector_id: string
	player_id: string
	udn: string
	room_name: string
	display_name: string | null
	friendly_name: string
	model_name: string | null
	model_number: string | null
	serial_num: string | null
	household_id: string | null
	host: string
	description_url: string
	audio_input_supported: number
	adopted: number
	last_seen_at: string | null
	raw_description_xml: string | null
}

function mapSonosPlayerRow(row: SonosPlayerRow): SonosPersistedPlayer {
	return {
		playerId: row.player_id,
		udn: row.udn,
		roomName: row.room_name,
		displayName: row.display_name,
		friendlyName: row.friendly_name,
		modelName: row.model_name,
		modelNumber: row.model_number,
		serialNum: row.serial_num,
		householdId: row.household_id,
		host: row.host,
		descriptionUrl: row.description_url,
		audioInputSupported: Boolean(row.audio_input_supported),
		adopted: Boolean(row.adopted),
		lastSeenAt: row.last_seen_at,
		rawDescriptionXml: row.raw_description_xml,
	}
}

function selectSonosPlayerRows(
	storage: HomeConnectorStorage,
	connectorId: string,
): Array<SonosPlayerRow> {
	const statement = storage.db.query(`
		SELECT
			connector_id,
			player_id,
			udn,
			room_name,
			display_name,
			friendly_name,
			model_name,
			model_number,
			serial_num,
			household_id,
			host,
			description_url,
			audio_input_supported,
			adopted,
			last_seen_at,
			raw_description_xml
		FROM sonos_players
		WHERE connector_id = ?
		ORDER BY room_name COLLATE NOCASE, player_id
	`)
	return statement.all(connectorId) as Array<SonosPlayerRow>
}

function getUpsertSonosPlayerStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO sonos_players (
			connector_id,
			player_id,
			udn,
			room_name,
			display_name,
			friendly_name,
			model_name,
			model_number,
			serial_num,
			household_id,
			host,
			description_url,
			audio_input_supported,
			adopted,
			last_seen_at,
			raw_description_xml,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, player_id) DO UPDATE SET
			udn = excluded.udn,
			room_name = excluded.room_name,
			display_name = excluded.display_name,
			friendly_name = excluded.friendly_name,
			model_name = excluded.model_name,
			model_number = excluded.model_number,
			serial_num = excluded.serial_num,
			household_id = excluded.household_id,
			host = excluded.host,
			description_url = excluded.description_url,
			audio_input_supported = excluded.audio_input_supported,
			last_seen_at = excluded.last_seen_at,
			raw_description_xml = excluded.raw_description_xml,
			updated_at = excluded.updated_at
	`)
}

function getDeleteMissingSonosPlayersStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM sonos_players
		WHERE connector_id = ?
			AND player_id NOT IN (
				SELECT value
				FROM json_each(?)
			)
			AND adopted = 0
	`)
}

function getUpdateSonosAdoptedStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE sonos_players
		SET adopted = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND player_id = ?
	`)
}

export function listSonosPlayers(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectSonosPlayerRows(storage, connectorId).map(mapSonosPlayerRow)
}

export function getSonosPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	return (
		listSonosPlayers(storage, connectorId).find(
			(player) => player.playerId === playerId,
		) ?? null
	)
}

export function requireSonosPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	const player = getSonosPlayer(storage, connectorId, playerId)
	if (!player) {
		throw new Error(`Sonos player "${playerId}" was not found.`)
	}
	return player
}

export function upsertDiscoveredSonosPlayers(
	storage: HomeConnectorStorage,
	connectorId: string,
	players: Array<SonosPlayerRecord>,
) {
	const existing = new Map(
		listSonosPlayers(storage, connectorId).map((player) => [
			player.playerId,
			player,
		]),
	)
	const now = new Date().toISOString()
	const upsertStatement = getUpsertSonosPlayerStatement(storage)
	for (const player of players) {
		const current = existing.get(player.playerId)
		upsertStatement.run(
			connectorId,
			player.playerId,
			player.udn,
			player.roomName,
			player.displayName,
			player.friendlyName,
			player.modelName,
			player.modelNumber,
			player.serialNum,
			player.householdId,
			player.host,
			player.descriptionUrl,
			player.audioInputSupported ? 1 : 0,
			current?.adopted ? 1 : player.adopted ? 1 : 0,
			player.lastSeenAt,
			player.rawDescriptionXml,
			now,
		)
	}
	getDeleteMissingSonosPlayersStatement(storage).run(
		connectorId,
		JSON.stringify(players.map((player) => player.playerId)),
	)
	return listSonosPlayers(storage, connectorId)
}

export function adoptSonosPlayer(
	storage: HomeConnectorStorage,
	connectorId: string,
	playerId: string,
) {
	getUpdateSonosAdoptedStatement(storage).run(1, connectorId, playerId)
	return getSonosPlayer(storage, connectorId, playerId)
}
