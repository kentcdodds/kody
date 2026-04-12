import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { type HomeConnectorConfig } from '../config.ts'

type SqliteStatement = {
	all(...params: Array<SQLInputValue>): Array<unknown>
	get(...params: Array<SQLInputValue>): unknown
	run(...params: Array<SQLInputValue>): unknown
}

type SqliteDatabase = {
	exec(sql: string): void
	query(sql: string): SqliteStatement
	close(): void
}

// Wrap Node's sqlite API behind the tiny interface this package actually uses.

export type HomeConnectorStorage = {
	db: SqliteDatabase
	sharedSecret: string | null
	close(): void
}

function ensureParentDirectory(dbPath: string) {
	if (dbPath === ':memory:') return
	mkdirSync(path.dirname(dbPath), {
		recursive: true,
	})
}

function initializeSchema(db: SqliteDatabase) {
	db.exec(`
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS samsung_tvs (
			connector_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			host TEXT NOT NULL,
			name TEXT NOT NULL,
			service_url TEXT,
			model TEXT,
			model_name TEXT,
			mac_address TEXT,
			frame_tv_support INTEGER NOT NULL DEFAULT 0,
			token_auth_support INTEGER NOT NULL DEFAULT 0,
			power_state TEXT,
			raw_device_info_json TEXT,
			adopted INTEGER NOT NULL DEFAULT 0,
			last_seen_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, device_id)
		);

		CREATE TABLE IF NOT EXISTS samsung_tokens (
			connector_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			token TEXT NOT NULL,
			last_verified_at TEXT,
			last_auth_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, device_id),
			FOREIGN KEY (connector_id, device_id)
				REFERENCES samsung_tvs(connector_id, device_id)
				ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS lutron_processors (
			connector_id TEXT NOT NULL,
			processor_id TEXT NOT NULL,
			instance_name TEXT NOT NULL,
			name TEXT NOT NULL,
			host TEXT NOT NULL,
			port INTEGER NOT NULL,
			discovery_port INTEGER,
			address TEXT,
			serial_number TEXT,
			mac_address TEXT,
			system_type TEXT,
			code_version TEXT,
			device_class TEXT,
			claim_status TEXT,
			network_status TEXT,
			firmware_status TEXT,
			status TEXT,
			raw_discovery_json TEXT,
			last_seen_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, processor_id)
		);

		CREATE TABLE IF NOT EXISTS lutron_credentials (
			connector_id TEXT NOT NULL,
			processor_id TEXT NOT NULL,
			username TEXT NOT NULL,
			password TEXT NOT NULL,
			last_authenticated_at TEXT,
			last_auth_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, processor_id),
			FOREIGN KEY (connector_id, processor_id)
				REFERENCES lutron_processors(connector_id, processor_id)
				ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS bond_bridges (
			connector_id TEXT NOT NULL,
			bridge_id TEXT NOT NULL,
			bondid TEXT NOT NULL,
			instance_name TEXT NOT NULL,
			host TEXT NOT NULL,
			port INTEGER NOT NULL DEFAULT 80,
			model TEXT,
			fw_ver TEXT,
			raw_discovery_json TEXT,
			adopted INTEGER NOT NULL DEFAULT 0,
			last_seen_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, bridge_id)
		);

		CREATE TABLE IF NOT EXISTS bond_tokens (
			connector_id TEXT NOT NULL,
			bridge_id TEXT NOT NULL,
			token TEXT NOT NULL,
			last_verified_at TEXT,
			last_auth_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, bridge_id),
			FOREIGN KEY (connector_id, bridge_id)
				REFERENCES bond_bridges(connector_id, bridge_id)
				ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS sonos_players (
			connector_id TEXT NOT NULL,
			player_id TEXT NOT NULL,
			udn TEXT NOT NULL,
			room_name TEXT NOT NULL,
			display_name TEXT,
			friendly_name TEXT NOT NULL,
			model_name TEXT,
			model_number TEXT,
			serial_num TEXT,
			household_id TEXT,
			host TEXT NOT NULL,
			description_url TEXT NOT NULL,
			audio_input_supported INTEGER NOT NULL DEFAULT 0,
			adopted INTEGER NOT NULL DEFAULT 0,
			last_seen_at TEXT,
			raw_description_xml TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (connector_id, player_id)
		);
	`)
}

function createSqliteDatabase(dbPath: string): SqliteDatabase {
	const db = new DatabaseSync(dbPath)
	return {
		exec(sql) {
			db.exec(sql)
		},
		query(sql) {
			const statement = db.prepare(sql)
			return {
				all(...params) {
					return statement.all(...params)
				},
				get(...params) {
					return statement.get(...params)
				},
				run(...params) {
					return statement.run(...params)
				},
			}
		},
		close() {
			db.close()
		},
	}
}

export function createHomeConnectorStorage(
	config: HomeConnectorConfig,
): HomeConnectorStorage {
	ensureParentDirectory(config.dbPath)
	const db = createSqliteDatabase(config.dbPath)
	initializeSchema(db)
	return {
		db,
		sharedSecret: config.sharedSecret,
		close() {
			db.close()
		},
	}
}
