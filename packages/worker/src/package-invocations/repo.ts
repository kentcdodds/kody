import {
	nullable,
	object,
	parseSafe,
	string,
	type InferOutput,
} from 'remix/data-schema'
import { toHex } from '@kody-internal/shared/hex.ts'

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

function parseStoredResponse(
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

export async function insertPackageInvocationRow(input: {
	db: D1Database
	row: {
		id: string
		userId: string
		tokenId: string
		packageId: string
		packageKodyId: string
		exportName: string
		idempotencyKey: string
		requestHash: string
		source?: string | null
		topic?: string | null
		status: 'in_progress' | 'completed' | 'failed'
		response?: PackageInvocationStoredResponse | null
	}
}) {
	const now = new Date().toISOString()
	const responseJson = input.row.response
		? JSON.stringify({
				status: input.row.response.status,
				body: input.row.response.body,
			})
		: null
	const result = await input.db
		.prepare(
			`INSERT OR IGNORE INTO package_invocations (
				id,
				user_id,
				token_id,
				package_id,
				package_kody_id,
				export_name,
				idempotency_key,
				request_hash,
				source,
				topic,
				status,
				response_json,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.row.id,
			input.row.userId,
			input.row.tokenId,
			input.row.packageId,
			input.row.packageKodyId,
			input.row.exportName,
			input.row.idempotencyKey,
			input.row.requestHash,
			input.row.source ?? null,
			input.row.topic ?? null,
			input.row.status,
			responseJson,
			now,
			now,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

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

export async function updatePackageInvocationResult(input: {
	db: D1Database
	id: string
	userId: string
	status: 'completed' | 'failed'
	response: PackageInvocationStoredResponse
}) {
	const responseJson = JSON.stringify({
		status: input.response.status,
		body: input.response.body,
	})
	const result = await input.db
		.prepare(
			`UPDATE package_invocations
			SET status = ?, response_json = ?, updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			input.status,
			responseJson,
			new Date().toISOString(),
			input.id,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}
