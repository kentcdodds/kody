import {
	nullable,
	object,
	parseSafe,
	string,
	type InferOutput,
} from 'remix/data-schema'
import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import { toHex } from '@kody-internal/shared/hex.ts'

/**
 * Replay-cache ceiling for `response_json`. Rows above this would serialize
 * into D1 export statements that D1's import path rejects (SQLITE_TOOBIG),
 * making the whole backup un-restorable. Oversized terminal responses are
 * stored as NULL; idempotent duplicates of those invocations get the
 * existing `idempotency_response_unavailable` outcome instead of a replay.
 */
export const maxStoredInvocationResponseJsonBytes = maxRestorableTextColumnBytes

/**
 * Serialize a terminal response for the replay cache, dropping it when
 * oversized. Shared by the legacy D1 write path and the RunLog DO ledger so
 * both stores enforce the same restore-safe bound.
 */
export function boundedResponseJson(
	response: PackageInvocationStoredResponse,
): string | null {
	const responseJson = JSON.stringify({
		status: response.status,
		body: response.body,
	})
	if (utf8ByteLength(responseJson) > maxStoredInvocationResponseJsonBytes) {
		return null
	}
	return responseJson
}

const packageInvocationRowSchema = object({
	id: string(),
	user_id: string(),
	token_id: string(),
	package_id: string(),
	package_kody_id: string(),
	export_name: string(),
	idempotency_key: string(),
	request_hash: string(),
	source: nullable(string()),
	topic: nullable(string()),
	status: string(),
	response_json: nullable(string()),
	created_at: string(),
	updated_at: string(),
})

const packageInvocationTokenRowSchema = object({
	id: string(),
	user_id: string(),
	token_hash: string(),
	name: string(),
	email: string(),
	display_name: string(),
	package_ids_json: string(),
	package_kody_ids_json: string(),
	export_names_json: string(),
	sources_json: string(),
	created_at: string(),
	updated_at: string(),
	last_used_at: nullable(string()),
	revoked_at: nullable(string()),
})

export type PackageInvocationStoredResponse = {
	status: number
	body: Record<string, unknown>
}

export type PackageInvocationRecord = InferOutput<
	typeof packageInvocationRowSchema
> & {
	storedResponse: PackageInvocationStoredResponse | null
}

export type PackageInvocationTokenRecord = InferOutput<
	typeof packageInvocationTokenRowSchema
> & {
	packageIds: Array<string>
	packageKodyIds: Array<string>
	exportNames: Array<string>
	sources: Array<string>
}

export async function hashPackageInvocationBearerToken(token: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token),
	)
	return toHex(new Uint8Array(digest))
}

function parseStringArrayJson(input: { value: string; field: string }) {
	let parsed: unknown
	try {
		parsed = JSON.parse(input.value) as unknown
	} catch {
		throw new Error(
			`Invalid package invocation token record: ${input.field} must be valid JSON.`,
		)
	}
	if (!Array.isArray(parsed)) {
		throw new Error(
			`Invalid package invocation token record: ${input.field} must be a JSON array.`,
		)
	}
	return parsed.map((entry) => {
		if (typeof entry !== 'string' || !entry.trim()) {
			throw new Error(
				`Invalid package invocation token record: ${input.field} must contain only non-empty strings.`,
			)
		}
		return entry.trim()
	})
}

export function parseStoredResponse(
	value: string | null,
): PackageInvocationStoredResponse | null {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const status = record['status']
		const body = record['body']
		if (
			typeof status !== 'number' ||
			!Number.isInteger(status) ||
			!body ||
			typeof body !== 'object' ||
			Array.isArray(body)
		) {
			return null
		}
		return {
			status,
			body: body as Record<string, unknown>,
		}
	} catch {
		return null
	}
}

function mapTokenRow(
	row: Record<string, unknown>,
): PackageInvocationTokenRecord {
	const parsed = parseSafe(packageInvocationTokenRowSchema, row)
	if (!parsed.success) {
		const message = parsed.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid package invocation token record: ${message}`)
	}
	return {
		...parsed.value,
		packageIds: parseStringArrayJson({
			value: parsed.value.package_ids_json,
			field: 'package_ids_json',
		}),
		packageKodyIds: parseStringArrayJson({
			value: parsed.value.package_kody_ids_json,
			field: 'package_kody_ids_json',
		}),
		exportNames: parseStringArrayJson({
			value: parsed.value.export_names_json,
			field: 'export_names_json',
		}),
		sources: parseStringArrayJson({
			value: parsed.value.sources_json,
			field: 'sources_json',
		}),
	}
}

function mapRow(row: Record<string, unknown>): PackageInvocationRecord {
	const parsed = parseSafe(packageInvocationRowSchema, row)
	if (!parsed.success) {
		const message = parsed.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid package invocation record: ${message}`)
	}
	return {
		...parsed.value,
		storedResponse: parseStoredResponse(parsed.value.response_json),
	}
}

export async function getActivePackageInvocationTokenByHash(input: {
	db: D1Database
	tokenHash: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM package_invocation_tokens
			WHERE token_hash = ?
				AND revoked_at IS NULL
			LIMIT 1`,
		)
		.bind(input.tokenHash)
		.first<Record<string, unknown>>()
	return row ? mapTokenRow(row) : null
}

export async function updatePackageInvocationTokenLastUsed(input: {
	db: D1Database
	id: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE package_invocation_tokens
			SET last_used_at = ?
			WHERE id = ? AND revoked_at IS NULL`,
		)
		.bind(new Date().toISOString(), input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listPackageInvocationTokensByUserId(input: {
	db: D1Database
	userId: string
}) {
	const rows = await input.db
		.prepare(
			`SELECT *
			FROM package_invocation_tokens
			WHERE user_id = ?
			ORDER BY created_at DESC, name ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? []).map(mapTokenRow)
}

export async function getPackageInvocationTokenById(input: {
	db: D1Database
	userId: string
	tokenId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM package_invocation_tokens
			WHERE id = ?
				AND user_id = ?
			LIMIT 1`,
		)
		.bind(input.tokenId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapTokenRow(row) : null
}

export async function insertPackageInvocationToken(input: {
	db: D1Database
	row: {
		id: string
		userId: string
		name: string
		tokenHash: string
		email: string
		displayName: string
		packageIds: Array<string>
		packageKodyIds: Array<string>
		exportNames: Array<string>
		sources: Array<string>
	}
}) {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO package_invocation_tokens (
				id,
				user_id,
				name,
				token_hash,
				email,
				display_name,
				package_ids_json,
				package_kody_ids_json,
				export_names_json,
				sources_json,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.row.id,
			input.row.userId,
			input.row.name,
			input.row.tokenHash,
			input.row.email,
			input.row.displayName,
			JSON.stringify(input.row.packageIds),
			JSON.stringify(input.row.packageKodyIds),
			JSON.stringify(input.row.exportNames),
			JSON.stringify(input.row.sources),
			now,
			now,
		)
		.run()
}

export async function updatePackageInvocationToken(input: {
	db: D1Database
	userId: string
	id: string
	name: string
	tokenHash?: string
	packageIds: Array<string>
	packageKodyIds: Array<string>
	exportNames: Array<string>
	sources: Array<string>
}) {
	const result = await input.db
		.prepare(
			`UPDATE package_invocation_tokens
			SET name = ?,
				token_hash = COALESCE(?, token_hash),
				package_ids_json = ?,
				package_kody_ids_json = ?,
				export_names_json = ?,
				sources_json = ?,
				updated_at = ?
			WHERE id = ?
				AND user_id = ?
				AND revoked_at IS NULL`,
		)
		.bind(
			input.name,
			input.tokenHash ?? null,
			JSON.stringify(input.packageIds),
			JSON.stringify(input.packageKodyIds),
			JSON.stringify(input.exportNames),
			JSON.stringify(input.sources),
			new Date().toISOString(),
			input.id,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function revokePackageInvocationToken(input: {
	db: D1Database
	userId: string
	id: string
}) {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE package_invocation_tokens
			SET revoked_at = ?, updated_at = ?
			WHERE id = ?
				AND user_id = ?
				AND revoked_at IS NULL`,
		)
		.bind(now, now, input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function reinstatePackageInvocationToken(input: {
	db: D1Database
	userId: string
	id: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE package_invocation_tokens
			SET revoked_at = NULL, updated_at = ?
			WHERE id = ?
				AND user_id = ?
				AND revoked_at IS NOT NULL`,
		)
		.bind(new Date().toISOString(), input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deletePackageInvocationToken(input: {
	db: D1Database
	userId: string
	id: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM package_invocation_tokens
			WHERE id = ?
				AND user_id = ?`,
		)
		.bind(input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Dual-read fallback lookup for keys claimed before the idempotency ledger
 * moved into the per-user RunLog Durable Object. The D1 table is read-only
 * now — the write helpers were removed with the migration — and a follow-up
 * removes this lookup together with the table and its retention sweep.
 */
export async function getPackageInvocationByKey(input: {
	db: D1Database
	userId: string
	tokenId: string
	packageId: string
	exportName: string
	idempotencyKey: string
}) {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM package_invocations
			WHERE user_id = ?
				AND token_id = ?
				AND package_id = ?
				AND export_name = ?
				AND idempotency_key = ?`,
		)
		.bind(
			input.userId,
			input.tokenId,
			input.packageId,
			input.exportName,
			input.idempotencyKey,
		)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}
