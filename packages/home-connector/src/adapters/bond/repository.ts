import { type SQLInputValue } from 'node:sqlite'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import { type BondDiscoveredBridge, type BondPersistedBridge } from './types.ts'

type BondBridgeRow = {
	connector_id: string
	bridge_id: string
	bondid: string
	instance_name: string
	host: string
	port: number
	model: string | null
	fw_ver: string | null
	raw_discovery_json: string | null
	adopted: number
	last_seen_at: string | null
	token: string | null
}

export type BondRequestLogInput = {
	connectorId: string
	bridgeId: string
	operation: string
	status: 'success' | 'failure' | 'cooldown'
	startedAt: string
	finishedAt: string
	durationMs: number
	baseUrlsTried: Array<string>
	errorName?: string | null
	errorMessage?: string | null
	networkFailure: boolean
}

export type BondReliabilityState = {
	connectorId: string
	bridgeId: string
	cooldownUntil: string | null
	lastFailureAt: string | null
	lastFailureReason: string | null
	updatedAt: string
}

type BondReliabilityStateRow = {
	connector_id: string
	bridge_id: string
	cooldown_until: string | null
	last_failure_at: string | null
	last_failure_reason: string | null
	updated_at: string
}

function parseBondRequestBaseUrls(value: unknown): Array<string> {
	if (typeof value !== 'string') return []
	try {
		const parsed = JSON.parse(value) as unknown
		return Array.isArray(parsed)
			? parsed.filter((entry) => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

function mapBondBridgeRow(row: BondBridgeRow): BondPersistedBridge {
	let rawDiscovery: Record<string, unknown> | null = null
	if (row.raw_discovery_json) {
		try {
			rawDiscovery = JSON.parse(row.raw_discovery_json) as Record<
				string,
				unknown
			>
		} catch {
			rawDiscovery = null
		}
	}
	return {
		bridgeId: row.bridge_id,
		bondid: row.bondid,
		instanceName: row.instance_name,
		host: row.host,
		port: row.port,
		model: row.model,
		fwVer: row.fw_ver,
		adopted: Boolean(row.adopted),
		lastSeenAt: row.last_seen_at,
		hasStoredToken: Boolean(row.token),
		rawDiscovery,
	}
}

function selectBondBridgeRows(
	storage: HomeConnectorStorage,
	connectorId: string,
): Array<BondBridgeRow> {
	const statement = storage.db.query(`
		SELECT
			b.connector_id,
			b.bridge_id,
			b.bondid,
			b.instance_name,
			b.host,
			b.port,
			b.model,
			b.fw_ver,
			b.raw_discovery_json,
			b.adopted,
			b.last_seen_at,
			t.token AS token
		FROM bond_bridges b
		LEFT JOIN bond_tokens t
			ON t.connector_id = b.connector_id AND t.bridge_id = b.bridge_id
		WHERE b.connector_id = ?
		ORDER BY b.instance_name COLLATE NOCASE, b.bridge_id
	`)
	return statement.all(connectorId) as Array<BondBridgeRow>
}

function mapBondReliabilityStateRow(
	row: BondReliabilityStateRow,
): BondReliabilityState {
	return {
		connectorId: row.connector_id,
		bridgeId: row.bridge_id,
		cooldownUntil: row.cooldown_until,
		lastFailureAt: row.last_failure_at,
		lastFailureReason: row.last_failure_reason,
		updatedAt: row.updated_at,
	}
}

function getUpsertBondBridgeStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO bond_bridges (
			connector_id,
			bridge_id,
			bondid,
			instance_name,
			host,
			port,
			model,
			fw_ver,
			raw_discovery_json,
			adopted,
			last_seen_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, bridge_id) DO UPDATE SET
			bondid = excluded.bondid,
			instance_name = excluded.instance_name,
			host = excluded.host,
			port = excluded.port,
			model = excluded.model,
			fw_ver = excluded.fw_ver,
			raw_discovery_json = excluded.raw_discovery_json,
			last_seen_at = excluded.last_seen_at,
			updated_at = excluded.updated_at
	`)
}

function getUpdateBondAdoptedStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		UPDATE bond_bridges
		SET adopted = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND bridge_id = ?
	`)
}

function getDeleteBondBridgeStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		DELETE FROM bond_bridges
		WHERE connector_id = ? AND bridge_id = ?
	`)
}

function getUpsertBondTokenStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO bond_tokens (
			connector_id,
			bridge_id,
			token,
			last_verified_at,
			last_auth_error,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, bridge_id) DO UPDATE SET
			token = excluded.token,
			last_verified_at = excluded.last_verified_at,
			last_auth_error = excluded.last_auth_error,
			updated_at = excluded.updated_at
	`)
}

function getUpsertBondReliabilityStateStatement(storage: HomeConnectorStorage) {
	return storage.db.query(`
		INSERT INTO bond_reliability_state (
			connector_id,
			bridge_id,
			cooldown_until,
			last_failure_at,
			last_failure_reason,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, bridge_id) DO UPDATE SET
			cooldown_until = excluded.cooldown_until,
			last_failure_at = excluded.last_failure_at,
			last_failure_reason = excluded.last_failure_reason,
			updated_at = excluded.updated_at
	`)
}

export function listBondBridges(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	return selectBondBridgeRows(storage, connectorId).map(mapBondBridgeRow)
}

export function getBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	return (
		listBondBridges(storage, connectorId).find(
			(bridge) => bridge.bridgeId === bridgeId,
		) ?? null
	)
}

export function requireBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	const bridge = getBondBridge(storage, connectorId, bridgeId)
	if (!bridge) {
		throw new Error(`Bond bridge "${bridgeId}" was not found.`)
	}
	return bridge
}

export function getBondTokenSecret(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
): string | null {
	const row = storage.db
		.query(
			`
		SELECT token FROM bond_tokens
		WHERE connector_id = ? AND bridge_id = ?
	`,
		)
		.get(connectorId, bridgeId) as { token: string } | undefined
	return row?.token ?? null
}

export function insertBondRequestLog(
	storage: HomeConnectorStorage,
	input: BondRequestLogInput,
) {
	storage.db
		.query(
			`
		INSERT INTO bond_request_logs (
			connector_id,
			bridge_id,
			operation,
			status,
			started_at,
			finished_at,
			duration_ms,
			base_urls_tried_json,
			error_name,
			error_message,
			network_failure
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		)
		.run(
			input.connectorId,
			input.bridgeId,
			input.operation,
			input.status,
			input.startedAt,
			input.finishedAt,
			Math.max(0, Math.round(input.durationMs)),
			JSON.stringify(input.baseUrlsTried),
			input.errorName ?? null,
			input.errorMessage ?? null,
			input.networkFailure ? 1 : 0,
		)
}

export function pruneBondRequestLogs(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	limit: number
}) {
	const limit = Math.max(1, Math.floor(input.limit))
	input.storage.db
		.query(
			`
		DELETE FROM bond_request_logs
		WHERE connector_id = ? AND bridge_id = ?
			AND id NOT IN (
				SELECT id
				FROM bond_request_logs
				WHERE connector_id = ? AND bridge_id = ?
				ORDER BY started_at DESC, id DESC
				LIMIT ?
			)
	`,
		)
		.run(
			input.connectorId,
			input.bridgeId,
			input.connectorId,
			input.bridgeId,
			limit,
		)
}

export function getBondReliabilityState(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	const row = storage.db
		.query(
			`
		SELECT
			connector_id,
			bridge_id,
			cooldown_until,
			last_failure_at,
			last_failure_reason,
			updated_at
		FROM bond_reliability_state
		WHERE connector_id = ? AND bridge_id = ?
	`,
		)
		.get(connectorId, bridgeId) as BondReliabilityStateRow | undefined
	return row ? mapBondReliabilityStateRow(row) : null
}

export function saveBondReliabilityFailure(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	cooldownUntil: string
	failureAt: string
	failureReason: string
}) {
	getUpsertBondReliabilityStateStatement(input.storage).run(
		input.connectorId,
		input.bridgeId,
		input.cooldownUntil,
		input.failureAt,
		input.failureReason,
		input.failureAt,
	)
}

export function clearBondReliabilityCooldown(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
}) {
	const existing = getBondReliabilityState(
		input.storage,
		input.connectorId,
		input.bridgeId,
	)
	if (!existing) return
	getUpsertBondReliabilityStateStatement(input.storage).run(
		input.connectorId,
		input.bridgeId,
		null,
		existing.lastFailureAt,
		existing.lastFailureReason,
		new Date().toISOString(),
	)
}

export function listRecentBondRequestLogs(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId?: string
	limit?: number
}) {
	const limit = Math.max(1, Math.floor(input.limit ?? 100))
	const params: Array<SQLInputValue> = [input.connectorId]
	let bridgeFilter = ''
	if (input.bridgeId) {
		bridgeFilter = 'AND bridge_id = ?'
		params.push(input.bridgeId)
	}
	params.push(limit)
	const rows = input.storage.db
		.query(
			`
		SELECT
			id,
			connector_id,
			bridge_id,
			operation,
			status,
			started_at,
			finished_at,
			duration_ms,
			base_urls_tried_json,
			error_name,
			error_message,
			network_failure
		FROM bond_request_logs
		WHERE connector_id = ?
			${bridgeFilter}
		ORDER BY started_at DESC, id DESC
		LIMIT ?
	`,
		)
		.all(...params) as Array<Record<string, unknown>>
	return rows.map((row) => ({
		id: Number(row['id']),
		connectorId: String(row['connector_id']),
		bridgeId: String(row['bridge_id']),
		operation: String(row['operation']),
		status: String(row['status']),
		startedAt: String(row['started_at']),
		finishedAt: String(row['finished_at']),
		durationMs: Number(row['duration_ms']),
		baseUrlsTried: parseBondRequestBaseUrls(row['base_urls_tried_json']),
		errorName: typeof row['error_name'] === 'string' ? row['error_name'] : null,
		errorMessage:
			typeof row['error_message'] === 'string' ? row['error_message'] : null,
		networkFailure: Boolean(row['network_failure']),
	}))
}

export function upsertDiscoveredBondBridges(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridges: Array<BondDiscoveredBridge>,
) {
	const existing = new Map(
		listBondBridges(storage, connectorId).map((bridge) => [
			bridge.bridgeId,
			bridge,
		]),
	)
	const now = new Date().toISOString()
	const upsertStatement = getUpsertBondBridgeStatement(storage)
	for (const bridge of bridges) {
		const current = existing.get(bridge.bridgeId)
		upsertStatement.run(
			connectorId,
			bridge.bridgeId,
			bridge.bondid,
			bridge.instanceName,
			bridge.host,
			bridge.port,
			bridge.model,
			bridge.fwVer,
			JSON.stringify(bridge.rawDiscovery),
			current?.adopted ? 1 : 0,
			bridge.lastSeenAt,
			now,
		)
	}
	const deleteStatement = storage.db.query(`
		DELETE FROM bond_bridges
		WHERE connector_id = ?
			AND adopted = 0
			AND bridge_id NOT IN (
				SELECT value FROM json_each(?)
			)
	`)
	if (bridges.length > 0) {
		deleteStatement.run(
			connectorId,
			JSON.stringify(bridges.map((bridge) => bridge.bridgeId)),
		)
	}
	return listBondBridges(storage, connectorId)
}

export function adoptBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	getUpdateBondAdoptedStatement(storage).run(1, connectorId, bridgeId)
	return requireBondBridge(storage, connectorId, bridgeId)
}

export function releaseBondBridge(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
) {
	if (!getBondBridge(storage, connectorId, bridgeId)) {
		throw new Error(`Bond bridge "${bridgeId}" was not found.`)
	}
	getDeleteBondBridgeStatement(storage).run(connectorId, bridgeId)
}

export function pruneNonAdoptedBondBridges(
	storage: HomeConnectorStorage,
	connectorId: string,
) {
	storage.db
		.query(
			`
		DELETE FROM bond_bridges
		WHERE connector_id = ? AND adopted = 0
	`,
		)
		.run(connectorId)
}

export function saveBondToken(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	token: string
	lastVerifiedAt: string | null
	lastAuthError: string | null
}) {
	const now = new Date().toISOString()
	getUpsertBondTokenStatement(input.storage).run(
		input.connectorId,
		input.bridgeId,
		input.token,
		input.lastVerifiedAt,
		input.lastAuthError,
		now,
	)
}

export function updateBondBridgeConnection(
	storage: HomeConnectorStorage,
	connectorId: string,
	bridgeId: string,
	input: { host: string; port?: number },
) {
	const port = input.port ?? 80
	storage.db
		.query(
			`
		UPDATE bond_bridges
		SET host = ?, port = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND bridge_id = ?
	`,
		)
		.run(input.host, port, connectorId, bridgeId)
	return requireBondBridge(storage, connectorId, bridgeId)
}

export function updateBondBridgeLastSeen(input: {
	storage: HomeConnectorStorage
	connectorId: string
	bridgeId: string
	lastSeenAt: string
}) {
	input.storage.db
		.query(
			`
		UPDATE bond_bridges
		SET last_seen_at = ?, updated_at = CURRENT_TIMESTAMP
		WHERE connector_id = ? AND bridge_id = ?
	`,
		)
		.run(input.lastSeenAt, input.connectorId, input.bridgeId)
}
