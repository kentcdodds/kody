import { BackupError } from './backup-policy.ts'
import { type ApiOptions, classifyHttpStatus } from './d1-export-api.ts'

interface JsonObject {
	[key: string]: unknown
}

const DEFAULT_REQUEST_ATTEMPTS = 5
const MAX_RETRY_DELAY = 60_000
const DEFAULT_POLL_ATTEMPTS = 120
const DEFAULT_POLL_DELAY_MS = 2_000

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function retryDelay(response: Response, attempt: number): number {
	const retryAfter = response.headers.get('retry-after')
	if (retryAfter && /^\d+$/.test(retryAfter)) {
		return Math.min(Number(retryAfter) * 1_000, MAX_RETRY_DELAY)
	}
	return Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY)
}

async function apiEnvelope(
	url: string,
	init: RequestInit,
	options: ApiOptions,
): Promise<unknown> {
	const fetcher = options.fetcher ?? fetch
	const sleep =
		options.sleep ?? ((milliseconds) => scheduler.wait(milliseconds))
	const attempts = options.maxRequestAttempts ?? DEFAULT_REQUEST_ATTEMPTS
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let response: Response
		try {
			response = await fetcher(url, init)
		} catch {
			if (attempt === attempts) {
				throw new BackupError(
					'api-network-failure',
					'Cloudflare API request failed',
					true,
				)
			}
			await sleep(Math.min(1_000 * 2 ** (attempt - 1), MAX_RETRY_DELAY))
			continue
		}
		if (!response.ok) {
			const classification = classifyHttpStatus(response.status)
			switch (classification) {
				case 'hard':
					throw new BackupError(
						'api-auth-failure',
						`Cloudflare API rejected credentials (${response.status})`,
					)
				case 'retry':
					if (attempt < attempts) {
						await sleep(retryDelay(response, attempt))
						continue
					}
					throw new BackupError(
						'api-retries-exhausted',
						`Cloudflare API remained unavailable (${response.status})`,
						true,
					)
				case 'malformed':
					throw new BackupError(
						'api-http-error',
						`Cloudflare API returned HTTP ${response.status}`,
					)
				default: {
					const exhaustive: never = classification
					throw exhaustive
				}
			}
		}
		let body: unknown
		try {
			body = await response.json()
		} catch {
			throw new BackupError(
				'api-malformed-json',
				'Cloudflare API returned malformed JSON',
			)
		}
		if (!isObject(body) || body.success !== true) {
			throw new BackupError(
				'api-malformed-response',
				'Cloudflare API response envelope was invalid',
			)
		}
		return body.result
	}
	throw new BackupError(
		'api-retries-exhausted',
		'Cloudflare API retry limit reached',
	)
}

async function apiJson(
	url: string,
	init: RequestInit,
	options: ApiOptions,
): Promise<JsonObject> {
	const result = await apiEnvelope(url, init, options)
	if (!isObject(result)) {
		throw new BackupError(
			'api-malformed-response',
			'Cloudflare API response envelope was invalid',
		)
	}
	return result
}

function authHeaders(token: string): HeadersInit {
	return {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	}
}

function importUrl(accountId: string, databaseId: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/import`
}

export type CreatedDatabase = {
	uuid: string
	name: string
	createdAt: string
}

export async function createD1Database(input: {
	accountId: string
	name: string
	token: string
	options?: ApiOptions
}): Promise<CreatedDatabase> {
	const result = await apiJson(
		`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database`,
		{
			method: 'POST',
			headers: authHeaders(input.token),
			body: JSON.stringify({ name: input.name }),
		},
		input.options ?? {},
	)
	if (
		typeof result.uuid !== 'string' ||
		typeof result.name !== 'string' ||
		typeof result.created_at !== 'string'
	) {
		throw new BackupError(
			'api-malformed-identity',
			'D1 create response was invalid',
		)
	}
	return {
		uuid: result.uuid,
		name: result.name,
		createdAt: result.created_at,
	}
}

export async function deleteD1Database(input: {
	accountId: string
	databaseId: string
	token: string
	options?: ApiOptions
}): Promise<void> {
	await apiEnvelope(
		`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}`,
		{
			method: 'DELETE',
			headers: authHeaders(input.token),
		},
		input.options ?? {},
	)
}

export async function queryD1Database(input: {
	accountId: string
	databaseId: string
	token: string
	sql: string
	options?: ApiOptions
}): Promise<Array<Record<string, unknown>>> {
	const result = await apiEnvelope(
		`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
		{
			method: 'POST',
			headers: authHeaders(input.token),
			body: JSON.stringify({ sql: input.sql }),
		},
		input.options ?? {},
	)
	// Cloudflare wraps query results as an array of statement results.
	if (Array.isArray(result)) {
		const first = result[0]
		if (isObject(first) && Array.isArray(first.results)) {
			return first.results as Array<Record<string, unknown>>
		}
	}
	if (isObject(result) && Array.isArray(result.results)) {
		return result.results as Array<Record<string, unknown>>
	}
	throw new BackupError(
		'api-malformed-response',
		'D1 query response was invalid',
	)
}

export async function getD1Database(input: {
	accountId: string
	databaseId: string
	token: string
	options?: ApiOptions
}): Promise<{ uuid: string; name: string; fileSize: number }> {
	const result = await apiJson(
		`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}`,
		{ headers: authHeaders(input.token) },
		input.options ?? {},
	)
	if (
		typeof result.uuid !== 'string' ||
		typeof result.name !== 'string' ||
		!Number.isSafeInteger(result.file_size)
	) {
		throw new BackupError(
			'api-malformed-identity',
			'D1 identity response was invalid',
		)
	}
	return {
		uuid: result.uuid,
		name: result.name,
		fileSize: result.file_size as number,
	}
}

function hexMd5FromR2Etag(etag: string): string {
	const trimmed = etag.replaceAll('"', '').toLowerCase()
	if (!/^[0-9a-f]{32}$/.test(trimmed)) {
		throw new BackupError(
			'import-etag-invalid',
			'R2 object ETag is not a usable MD5 digest for D1 import',
		)
	}
	return trimmed
}

export async function importSqlIntoD1(input: {
	accountId: string
	databaseId: string
	token: string
	sqlBody: ReadableStream<Uint8Array> | Uint8Array | string
	md5Etag: string
	options?: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
	}
}): Promise<void> {
	const options = input.options ?? {}
	const fetcher = options.fetcher ?? fetch
	const sleep =
		options.sleep ?? ((milliseconds) => scheduler.wait(milliseconds))
	const etag = hexMd5FromR2Etag(input.md5Etag)
	const url = importUrl(input.accountId, input.databaseId)

	const initResult = await apiJson(
		url,
		{
			method: 'POST',
			headers: authHeaders(input.token),
			body: JSON.stringify({ action: 'init', etag }),
		},
		options,
	)
	if (
		typeof initResult.upload_url !== 'string' ||
		typeof initResult.filename !== 'string'
	) {
		throw new BackupError(
			'import-init-malformed',
			'D1 import init response was invalid',
		)
	}

	let uploadResponse: Response
	try {
		uploadResponse = await fetcher(initResult.upload_url, {
			method: 'PUT',
			body: input.sqlBody as BodyInit,
		})
	} catch {
		throw new BackupError(
			'import-upload-failed',
			'D1 import upload failed',
			true,
		)
	}
	if (!uploadResponse.ok) {
		throw new BackupError(
			'import-upload-http-error',
			`D1 import upload returned HTTP ${uploadResponse.status}`,
			uploadResponse.status === 429 || uploadResponse.status >= 500,
		)
	}
	const uploadedEtag = uploadResponse.headers.get('etag')?.replaceAll('"', '')
	if (
		uploadedEtag !== undefined &&
		uploadedEtag.toLowerCase() !== etag.toLowerCase()
	) {
		throw new BackupError(
			'import-etag-mismatch',
			'D1 import upload ETag did not match the SQL digest',
		)
	}

	const ingestResult = await apiJson(
		url,
		{
			method: 'POST',
			headers: authHeaders(input.token),
			body: JSON.stringify({
				action: 'ingest',
				etag,
				filename: initResult.filename,
			}),
		},
		options,
	)
	if (typeof ingestResult.at_bookmark !== 'string') {
		throw new BackupError(
			'import-ingest-malformed',
			'D1 import ingest response lacked a bookmark',
		)
	}

	const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_POLL_ATTEMPTS
	const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS
	let sawTerminalSuccess = false
	for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
		const pollResult = await apiJson(
			url,
			{
				method: 'POST',
				headers: authHeaders(input.token),
				body: JSON.stringify({
					action: 'poll',
					current_bookmark: ingestResult.at_bookmark,
				}),
			},
			options,
		)
		if (isTerminalImportSuccess(pollResult)) {
			sawTerminalSuccess = true
			return
		}
		if (pollResult.status === 'error') {
			throw new BackupError(
				'import-failed',
				typeof pollResult.error === 'string'
					? pollResult.error
					: 'D1 import failed',
			)
		}
		if (
			pollResult.success === false &&
			pollResult.error === 'Not currently importing anything.'
		) {
			// Only accept this after a prior terminal-success signal in this import.
			// Otherwise the poll window expired before completion was observed.
			if (sawTerminalSuccess) return
			throw new BackupError(
				'import-result-expired',
				'D1 import poll result expired before terminal success was observed',
			)
		}
		await sleep(pollDelayMs)
	}
	throw new BackupError(
		'import-poll-timeout',
		'D1 import polling exhausted its attempt budget',
		true,
	)
}

function isTerminalImportSuccess(pollResult: JsonObject): boolean {
	if (pollResult.status === 'complete') return true
	// Documented complete shape nests final_bookmark under result.
	return (
		pollResult.success === true &&
		isObject(pollResult.result) &&
		typeof pollResult.result.final_bookmark === 'string' &&
		pollResult.result.final_bookmark.length > 0
	)
}
