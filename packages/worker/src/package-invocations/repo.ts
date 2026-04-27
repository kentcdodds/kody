import {
	nullable,
	object,
	parseSafe,
	string,
	type InferOutput,
} from 'remix/data-schema'

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

export type PackageInvocationStoredResponse = {
	status: number
	body: Record<string, unknown>
}

export type PackageInvocationRecord = InferOutput<
	typeof packageInvocationRowSchema
> & {
	storedResponse: PackageInvocationStoredResponse | null
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
		const status =
			typeof record['status'] === 'string'
				? Number.parseInt(record['status'], 10)
				: Number.NaN
		const body = record['body']
		if (
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
				status: String(input.row.response.status),
				body: input.row.response.body,
			})
		: null
	await input.db
		.prepare(
			`INSERT INTO package_invocations (
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
		status: String(input.response.status),
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
