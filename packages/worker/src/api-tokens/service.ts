import {
	number,
	nullable,
	object,
	parseSafe,
	string,
	type InferOutput,
} from 'remix/data-schema'
import {
	formatApiToken,
	generateApiTokenId,
	generateApiTokenSecret,
	parseApiToken,
} from '@kody-internal/shared/api-token-format.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	apiTokenScopeSatisfies,
	localExecuteScope,
	normalizeApiTokenScopes,
	type ApiTokenScope,
} from './scopes.ts'

export const apiTokenPolicy = {
	defaultIdleTtlSeconds: 15 * 60,
	minIdleTtlSeconds: 60,
	maxIdleTtlSeconds: 60 * 60,
	defaultMaxLifetimeSeconds: 24 * 60 * 60,
	maxMaxLifetimeSeconds: 7 * 24 * 60 * 60,
	maxActiveTokensPerUser: 50,
	maxNameLength: 100,
	/**
	 * Sliding-expiry writes are skipped when they would extend the expiry by
	 * less than this (or a quarter of the idle TTL, whichever is smaller).
	 */
	touchDebounceSeconds: 60,
	/** Revoked or expired rows are deleted this long after they stop working. */
	inactiveRetentionSeconds: 7 * 24 * 60 * 60,
} as const

export const apiTokenCreatedVia = ['api', 'mcp-api'] as const
export type ApiTokenCreatedVia = (typeof apiTokenCreatedVia)[number]

const apiTokenRowSchema = object({
	id: string(),
	user_id: string(),
	name: string(),
	token_hash: string(),
	scopes_json: string(),
	idle_ttl_seconds: number(),
	expires_at: string(),
	max_expires_at: string(),
	created_via: string(),
	created_at: string(),
	updated_at: string(),
	last_used_at: nullable(string()),
	rotated_at: nullable(string()),
	revoked_at: nullable(string()),
})

type ApiTokenRow = InferOutput<typeof apiTokenRowSchema>

export type ApiTokenRecord = Omit<ApiTokenRow, 'scopes_json'> & {
	scopes: Array<ApiTokenScope>
}

export type ApiTokenStatus = 'active' | 'expired' | 'revoked'

/** Public token metadata. Never includes the plaintext or its hash. */
export type ApiTokenView = {
	id: string
	name: string
	scopes: Array<ApiTokenScope>
	status: ApiTokenStatus
	idle_ttl_seconds: number
	expires_at: string
	max_expires_at: string
	created_via: string
	created_at: string
	last_used_at: string | null
	rotated_at: string | null
	revoked_at: string | null
}

export type ApiTokenSecretView = ApiTokenView & {
	/** Shown once. Store it; Kody keeps only a hash. */
	token: string
	token_type: 'Bearer'
}

function mapRow(row: Record<string, unknown>): ApiTokenRecord {
	const parsed = parseSafe(apiTokenRowSchema, row)
	if (!parsed.success) {
		const message = parsed.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid API token record: ${message}`)
	}
	const { scopes_json, ...rest } = parsed.value
	return {
		...rest,
		scopes: normalizeApiTokenScopes(JSON.parse(scopes_json) as Array<unknown>),
	}
}

export function getApiTokenStatus(
	record: ApiTokenRecord,
	now: Date = new Date(),
): ApiTokenStatus {
	if (record.revoked_at) return 'revoked'
	return Date.parse(record.expires_at) > now.getTime() ? 'active' : 'expired'
}

export function toApiTokenView(
	record: ApiTokenRecord,
	now: Date = new Date(),
): ApiTokenView {
	return {
		id: record.id,
		name: record.name,
		scopes: record.scopes,
		status: getApiTokenStatus(record, now),
		idle_ttl_seconds: record.idle_ttl_seconds,
		expires_at: record.expires_at,
		max_expires_at: record.max_expires_at,
		created_via: record.created_via,
		created_at: record.created_at,
		last_used_at: record.last_used_at,
		rotated_at: record.rotated_at,
		revoked_at: record.revoked_at,
	}
}

function addSeconds(date: Date, seconds: number) {
	return new Date(date.getTime() + seconds * 1000)
}

function slidingExpiry(input: {
	now: Date
	idleTtlSeconds: number
	maxExpiresAt: string
}) {
	const idleExpiry = addSeconds(input.now, input.idleTtlSeconds).getTime()
	return new Date(
		Math.min(idleExpiry, Date.parse(input.maxExpiresAt)),
	).toISOString()
}

function readIntegerOption(input: {
	value: number | undefined
	fallback: number
	min: number
	max: number
	field: string
}) {
	if (input.value === undefined) return input.fallback
	if (
		!Number.isInteger(input.value) ||
		input.value < input.min ||
		input.value > input.max
	) {
		throw new McpCallerError(
			`${input.field} must be an integer between ${input.min} and ${input.max}.`,
		)
	}
	return input.value
}

function readTokenName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) throw new McpCallerError('Token name is required.')
	if (trimmed.length > apiTokenPolicy.maxNameLength) {
		throw new McpCallerError(
			`Token name must be at most ${apiTokenPolicy.maxNameLength} characters.`,
		)
	}
	return trimmed
}

async function hashSecret(secret: string) {
	return sha256Hex(secret)
}

async function pruneInactiveApiTokens(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	const cutoff = addSeconds(
		input.now,
		-apiTokenPolicy.inactiveRetentionSeconds,
	).toISOString()
	await input.db
		.prepare(
			`DELETE FROM api_tokens
			WHERE user_id = ?
				AND (revoked_at < ? OR expires_at < ?)`,
		)
		.bind(input.userId, cutoff, cutoff)
		.run()
}

async function countActiveApiTokens(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM api_tokens
			WHERE user_id = ?
				AND revoked_at IS NULL
				AND expires_at > ?`,
		)
		.bind(input.userId, input.now.toISOString())
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * The token doing the minting, when a token mints a token. A child token can
 * never hold scopes the parent lacks or outlive the parent's absolute expiry.
 */
export type ApiTokenMintParent = {
	scopes: ReadonlyArray<ApiTokenScope>
	maxExpiresAt: string
}

export async function mintApiToken(input: {
	db: D1Database
	userId: string
	name: string
	scopes: ReadonlyArray<unknown>
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	createdVia: ApiTokenCreatedVia
	allowLocalExecute: boolean
	parent?: ApiTokenMintParent
	now?: Date
}): Promise<ApiTokenSecretView> {
	const now = input.now ?? new Date()
	const name = readTokenName(input.name)
	let scopes: Array<ApiTokenScope>
	try {
		scopes = normalizeApiTokenScopes(input.scopes)
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : String(error),
		)
	}
	if (scopes.length === 0) {
		throw new McpCallerError('At least one scope is required.')
	}
	if (scopes.includes(localExecuteScope) && !input.allowLocalExecute) {
		throw new McpCallerError(
			'The local-execute scope is not available for this account yet.',
		)
	}
	const parent = input.parent
	if (parent) {
		const missing = scopes.filter(
			(scope) => !apiTokenScopeSatisfies(parent.scopes, scope),
		)
		if (missing.length > 0) {
			throw new McpCallerError(
				`A token cannot grant scopes it does not hold: ${missing.join(', ')}.`,
			)
		}
	}
	const idleTtlSeconds = readIntegerOption({
		value: input.idleTtlSeconds,
		fallback: apiTokenPolicy.defaultIdleTtlSeconds,
		min: apiTokenPolicy.minIdleTtlSeconds,
		max: apiTokenPolicy.maxIdleTtlSeconds,
		field: 'idle_ttl_seconds',
	})
	const maxLifetimeSeconds = readIntegerOption({
		value: input.maxLifetimeSeconds,
		fallback: Math.max(
			apiTokenPolicy.defaultMaxLifetimeSeconds,
			idleTtlSeconds,
		),
		min: idleTtlSeconds,
		max: apiTokenPolicy.maxMaxLifetimeSeconds,
		field: 'max_lifetime_seconds',
	})
	let maxExpiresAtMs = addSeconds(now, maxLifetimeSeconds).getTime()
	if (parent) {
		maxExpiresAtMs = Math.min(maxExpiresAtMs, Date.parse(parent.maxExpiresAt))
	}
	const maxExpiresAt = new Date(maxExpiresAtMs).toISOString()

	await pruneInactiveApiTokens({ db: input.db, userId: input.userId, now })
	const activeCount = await countActiveApiTokens({
		db: input.db,
		userId: input.userId,
		now,
	})
	if (activeCount >= apiTokenPolicy.maxActiveTokensPerUser) {
		throw new McpCallerError(
			`This account already has ${apiTokenPolicy.maxActiveTokensPerUser} active API tokens. Revoke one before minting another.`,
		)
	}

	const tokenId = generateApiTokenId()
	const secret = generateApiTokenSecret()
	const nowIso = now.toISOString()
	const record: ApiTokenRecord = {
		id: tokenId,
		user_id: input.userId,
		name,
		token_hash: await hashSecret(secret),
		scopes,
		idle_ttl_seconds: idleTtlSeconds,
		expires_at: slidingExpiry({ now, idleTtlSeconds, maxExpiresAt }),
		max_expires_at: maxExpiresAt,
		created_via: input.createdVia,
		created_at: nowIso,
		updated_at: nowIso,
		last_used_at: null,
		rotated_at: null,
		revoked_at: null,
	}
	await input.db
		.prepare(
			`INSERT INTO api_tokens (
				id,
				user_id,
				name,
				token_hash,
				scopes_json,
				idle_ttl_seconds,
				expires_at,
				max_expires_at,
				created_via,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.user_id,
			record.name,
			record.token_hash,
			JSON.stringify(record.scopes),
			record.idle_ttl_seconds,
			record.expires_at,
			record.max_expires_at,
			record.created_via,
			record.created_at,
			record.updated_at,
		)
		.run()
	return {
		...toApiTokenView(record, now),
		token: formatApiToken({ tokenId, secret }),
		token_type: 'Bearer',
	}
}

export async function getApiTokenRecord(input: {
	db: D1Database
	userId: string
	tokenId: string
}) {
	const row = await input.db
		.prepare(`SELECT * FROM api_tokens WHERE id = ? AND user_id = ? LIMIT 1`)
		.bind(input.tokenId, input.userId)
		.first<Record<string, unknown>>()
	return row ? mapRow(row) : null
}

export async function listApiTokens(input: {
	db: D1Database
	userId: string
	includeInactive?: boolean
	now?: Date
}) {
	const now = input.now ?? new Date()
	const rows = await input.db
		.prepare(
			`SELECT *
			FROM api_tokens
			WHERE user_id = ?
			ORDER BY created_at DESC, id ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (rows.results ?? [])
		.map(mapRow)
		.filter(
			(record) =>
				input.includeInactive || getApiTokenStatus(record, now) === 'active',
		)
		.map((record) => toApiTokenView(record, now))
}

export async function revokeApiToken(input: {
	db: D1Database
	userId: string
	tokenId: string
	now?: Date
}) {
	const nowIso = (input.now ?? new Date()).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE api_tokens
			SET revoked_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		)
		.bind(nowIso, nowIso, input.tokenId, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Replace the secret of an active token. The previous plaintext stops
 * working immediately; scopes and the absolute expiry are unchanged.
 */
export async function rotateApiToken(input: {
	db: D1Database
	userId: string
	tokenId: string
	now?: Date
}): Promise<ApiTokenSecretView | null> {
	const now = input.now ?? new Date()
	const record = await getApiTokenRecord(input)
	if (!record || getApiTokenStatus(record, now) !== 'active') return null
	const secret = generateApiTokenSecret()
	const nowIso = now.toISOString()
	const rotated: ApiTokenRecord = {
		...record,
		token_hash: await hashSecret(secret),
		expires_at: slidingExpiry({
			now,
			idleTtlSeconds: record.idle_ttl_seconds,
			maxExpiresAt: record.max_expires_at,
		}),
		rotated_at: nowIso,
		updated_at: nowIso,
	}
	const result = await input.db
		.prepare(
			`UPDATE api_tokens
			SET token_hash = ?, expires_at = ?, rotated_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ? AND token_hash = ? AND revoked_at IS NULL`,
		)
		.bind(
			rotated.token_hash,
			rotated.expires_at,
			rotated.rotated_at,
			rotated.updated_at,
			record.id,
			record.user_id,
			record.token_hash,
		)
		.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return {
		...toApiTokenView(rotated, now),
		token: formatApiToken({ tokenId: record.id, secret }),
		token_type: 'Bearer',
	}
}

export type ApiTokenAuthenticationFailure =
	| 'malformed'
	| 'unknown'
	| 'revoked'
	| 'expired'

export type ApiTokenAuthentication =
	| { ok: true; record: ApiTokenRecord }
	| { ok: false; reason: ApiTokenAuthenticationFailure }

export async function authenticateApiToken(input: {
	db: D1Database
	token: string
	now?: Date
}): Promise<ApiTokenAuthentication> {
	const parsed = parseApiToken(input.token)
	if (!parsed) return { ok: false, reason: 'malformed' }
	const row = await input.db
		.prepare(`SELECT * FROM api_tokens WHERE id = ? LIMIT 1`)
		.bind(parsed.tokenId)
		.first<Record<string, unknown>>()
	if (!row) return { ok: false, reason: 'unknown' }
	const record = mapRow(row)
	const hashMatches = await timingSafeEqualString(
		await hashSecret(parsed.secret),
		record.token_hash,
	)
	if (!hashMatches) return { ok: false, reason: 'unknown' }
	const status = getApiTokenStatus(record, input.now)
	switch (status) {
		case 'active':
			return { ok: true, record }
		case 'revoked':
			return { ok: false, reason: 'revoked' }
		case 'expired':
			return { ok: false, reason: 'expired' }
		default: {
			const exhaustive: never = status
			throw new Error(`Unexpected API token status: ${String(exhaustive)}`)
		}
	}
}

/**
 * The token as it stands after a successful request at `now`: `expires_at`
 * slid forward by the idle TTL, capped at the absolute expiry. After the first
 * use, returns `null` when the extension is smaller than the debounce window, so hot tokens do
 * not write D1 on every call. The window is at most a quarter of the idle
 * TTL, so a token in use always keeps at least three quarters of it.
 */
export function slideApiTokenExpiry(
	record: ApiTokenRecord,
	now: Date = new Date(),
): ApiTokenRecord | null {
	const expiresAt = slidingExpiry({
		now,
		idleTtlSeconds: record.idle_ttl_seconds,
		maxExpiresAt: record.max_expires_at,
	})
	const debounceMs =
		Math.min(apiTokenPolicy.touchDebounceSeconds, record.idle_ttl_seconds / 4) *
		1000
	if (
		record.last_used_at !== null &&
		Date.parse(expiresAt) - Date.parse(record.expires_at) < debounceMs
	) {
		return null
	}
	return { ...record, expires_at: expiresAt, last_used_at: now.toISOString() }
}

/** Persist a record returned by `slideApiTokenExpiry`. */
export async function touchApiToken(input: {
	db: D1Database
	record: ApiTokenRecord
}) {
	const usedAt = input.record.last_used_at ?? new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE api_tokens
			SET expires_at = ?, last_used_at = ?
			WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
		)
		.bind(input.record.expires_at, usedAt, input.record.id, usedAt)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** When a token was issued, for password-change lockout. */
export function getApiTokenIssuedAtMs(record: ApiTokenRecord) {
	return Date.parse(record.rotated_at ?? record.created_at)
}

export function apiTokenIdleTtlDescription() {
	return `Tokens expire after idle_ttl_seconds without use (default ${apiTokenPolicy.defaultIdleTtlSeconds}s, ${apiTokenPolicy.minIdleTtlSeconds}-${apiTokenPolicy.maxIdleTtlSeconds}s). Each successful request slides expires_at forward, never past max_expires_at (default ${apiTokenPolicy.defaultMaxLifetimeSeconds}s after mint, at most ${apiTokenPolicy.maxMaxLifetimeSeconds}s).`
}
