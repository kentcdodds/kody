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
 * Replay-cache ceiling for the ledger's `response_json`. The ledger lives in
 * the per-user RunLog Durable Object now, but the bound is kept at the
 * restore-safe D1 column ceiling it inherited: replay payloads above it were
 * never stored, so the DO rows stay small and export sections stay pageable.
 * Oversized terminal responses are stored as NULL; idempotent duplicates of
 * those invocations get the existing `idempotency_response_unavailable`
 * outcome instead of a replay.
 */
export const maxStoredInvocationResponseJsonBytes = maxRestorableTextColumnBytes

/**
 * Serialize a terminal response for the RunLog DO ledger's replay cache,
 * dropping it when oversized.
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
