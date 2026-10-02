import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	apiTokenScopeSatisfies,
	normalizeApiTokenScopes,
	type ApiTokenScope,
} from './scopes.ts'
import {
	apiTokenPolicy,
	mintApiToken,
	type ApiTokenMintParent,
	type ApiTokenSecretView,
} from './service.ts'

/** Distinct from `kody_at_` so chat/logs can show the CLI command safely. */
export const cliBootstrapCodePrefix = 'kody_bc_'

const bootstrapCodeIdLength = 16
const bootstrapCodeSecretBytes = 24
const bootstrapCodeIdAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const cliCredentialBootstrapPolicy = {
	/** Absolute redeem deadline (not sliding). */
	defaultRedeemTtlSeconds: 10 * 60,
	minRedeemTtlSeconds: 60,
	maxRedeemTtlSeconds: 15 * 60,
	maxOutstandingCodesPerUser: 5,
	defaultName: 'kody-cli-bootstrap',
	defaultScopes: [
		'local-execute',
		'account:read',
	] as const satisfies ReadonlyArray<ApiTokenScope>,
	cliCommand: (code: string) =>
		`npx @kodycodes/cli auth bootstrap --code ${code}`,
} as const

const bootstrapCodePattern = /^kody_bc_([a-z0-9]{16})_([A-Za-z0-9_-]{32})$/

export type ParsedCliBootstrapCode = {
	codeId: string
	secret: string
}

export type CliCredentialBootstrapView = {
	bootstrap_code: string
	expires_at: string
	cli_command: string
	name: string
	scopes: Array<ApiTokenScope>
	idle_ttl_seconds: number
	max_lifetime_seconds: number
}

function generateBootstrapCodeId() {
	const bytes = crypto.getRandomValues(new Uint8Array(bootstrapCodeIdLength))
	let id = ''
	for (const byte of bytes) {
		id += bootstrapCodeIdAlphabet[byte % bootstrapCodeIdAlphabet.length]
	}
	return id
}

function generateBootstrapCodeSecret() {
	return bytesToBase64Url(
		crypto.getRandomValues(new Uint8Array(bootstrapCodeSecretBytes)),
	)
}

export function formatCliBootstrapCode(input: ParsedCliBootstrapCode) {
	return `${cliBootstrapCodePrefix}${input.codeId}_${input.secret}`
}

export function parseCliBootstrapCode(
	value: string,
): ParsedCliBootstrapCode | null {
	const match = bootstrapCodePattern.exec(value.trim())
	if (!match) return null
	const [, codeId, secret] = match
	if (!codeId || !secret) return null
	return { codeId, secret }
}

async function hashBootstrapCode(code: string) {
	return sha256Hex(code.trim())
}

function readTokenName(name: string) {
	const trimmed = name.trim()
	if (trimmed.length === 0) {
		throw new McpCallerError('Token name must not be empty.')
	}
	if (trimmed.length > apiTokenPolicy.maxNameLength) {
		throw new McpCallerError(
			`Token name must be at most ${apiTokenPolicy.maxNameLength} characters.`,
		)
	}
	return trimmed
}

function readIntegerOption(input: {
	value: number | undefined
	fallback: number
	min: number
	max: number
	field: string
}) {
	const value = input.value ?? input.fallback
	if (!Number.isInteger(value) || value < input.min || value > input.max) {
		throw new McpCallerError(
			`${input.field} must be an integer between ${input.min} and ${input.max}.`,
		)
	}
	return value
}

async function countOutstandingBootstrapCodes(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM cli_credential_bootstrap_codes
			 WHERE user_id = ?
			   AND consumed_at IS NULL
			   AND expires_at > ?`,
		)
		.bind(input.userId, input.now.toISOString())
		.first<{ count: number }>()
	return row?.count ?? 0
}

async function pruneExpiredBootstrapCodes(input: {
	db: D1Database
	userId: string
	now: Date
}) {
	await input.db
		.prepare(
			`DELETE FROM cli_credential_bootstrap_codes
			 WHERE user_id = ?
			   AND (
			     (consumed_at IS NOT NULL AND consumed_at < ?)
			     OR (consumed_at IS NULL AND expires_at < ?)
			   )`,
		)
		.bind(
			input.userId,
			new Date(
				input.now.getTime() - apiTokenPolicy.inactiveRetentionSeconds * 1000,
			).toISOString(),
			input.now.toISOString(),
		)
		.run()
		.catch(() => undefined)
}

/**
 * Mint a one-shot bootstrap code for the CLI. Does **not** return a
 * `kody_at_` — the CLI redeems the code over HTTPS.
 */
export async function mintCliCredentialBootstrap(input: {
	db: D1Database
	userId: string
	name?: string
	scopes?: ReadonlyArray<unknown>
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	redeemTtlSeconds?: number
	parent?: ApiTokenMintParent
	now?: Date
}): Promise<CliCredentialBootstrapView> {
	const now = input.now ?? new Date()
	const name = readTokenName(
		input.name ?? cliCredentialBootstrapPolicy.defaultName,
	)
	let scopes: Array<ApiTokenScope>
	try {
		scopes = normalizeApiTokenScopes(
			input.scopes ?? [...cliCredentialBootstrapPolicy.defaultScopes],
		)
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : String(error),
		)
	}
	if (scopes.length === 0) {
		throw new McpCallerError('At least one scope is required.')
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
	let effectiveMaxLifetimeSeconds = maxLifetimeSeconds
	if (parent) {
		const parentRemainingSeconds = Math.floor(
			(Date.parse(parent.maxExpiresAt) - now.getTime()) / 1000,
		)
		if (parentRemainingSeconds < idleTtlSeconds) {
			throw new McpCallerError(
				'The calling API token expires too soon to mint a CLI bootstrap code.',
			)
		}
		effectiveMaxLifetimeSeconds = Math.min(
			effectiveMaxLifetimeSeconds,
			parentRemainingSeconds,
		)
	}
	const redeemTtlSeconds = readIntegerOption({
		value: input.redeemTtlSeconds,
		fallback: cliCredentialBootstrapPolicy.defaultRedeemTtlSeconds,
		min: cliCredentialBootstrapPolicy.minRedeemTtlSeconds,
		max: cliCredentialBootstrapPolicy.maxRedeemTtlSeconds,
		field: 'redeem_ttl_seconds',
	})

	await pruneExpiredBootstrapCodes({
		db: input.db,
		userId: input.userId,
		now,
	})
	const outstanding = await countOutstandingBootstrapCodes({
		db: input.db,
		userId: input.userId,
		now,
	})
	if (outstanding >= cliCredentialBootstrapPolicy.maxOutstandingCodesPerUser) {
		throw new McpCallerError(
			`This account already has ${cliCredentialBootstrapPolicy.maxOutstandingCodesPerUser} outstanding CLI bootstrap codes. Redeem or wait for expiry before minting another.`,
		)
	}

	const codeId = generateBootstrapCodeId()
	const secret = generateBootstrapCodeSecret()
	const bootstrapCode = formatCliBootstrapCode({ codeId, secret })
	const codeHash = await hashBootstrapCode(bootstrapCode)
	const nowIso = now.toISOString()
	const expiresAt = new Date(
		now.getTime() + redeemTtlSeconds * 1000,
	).toISOString()

	await input.db
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (
				id, user_id, code_hash, name, scopes_json,
				idle_ttl_seconds, max_lifetime_seconds, expires_at, created_at, consumed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			codeId,
			input.userId,
			codeHash,
			name,
			JSON.stringify(scopes),
			idleTtlSeconds,
			effectiveMaxLifetimeSeconds,
			expiresAt,
			nowIso,
		)
		.run()

	return {
		bootstrap_code: bootstrapCode,
		expires_at: expiresAt,
		cli_command: cliCredentialBootstrapPolicy.cliCommand(bootstrapCode),
		name,
		scopes,
		idle_ttl_seconds: idleTtlSeconds,
		max_lifetime_seconds: effectiveMaxLifetimeSeconds,
	}
}

/**
 * Exchange a one-shot bootstrap code for a normal `kody_at_` API token.
 * Burns the code atomically before minting.
 */
export async function redeemCliCredentialBootstrap(input: {
	db: D1Database
	code: string
	now?: Date
}): Promise<{ token: ApiTokenSecretView; userId: string }> {
	const now = input.now ?? new Date()
	const parsed = parseCliBootstrapCode(input.code)
	if (!parsed) {
		throw new McpCallerError('Invalid CLI bootstrap code.')
	}
	const codeHash = await hashBootstrapCode(input.code.trim())
	const row = await input.db
		.prepare(
			`SELECT id, user_id, code_hash, name, scopes_json,
			        idle_ttl_seconds, max_lifetime_seconds, expires_at, consumed_at
			 FROM cli_credential_bootstrap_codes
			 WHERE id = ?`,
		)
		.bind(parsed.codeId)
		.first<{
			id: string
			user_id: string
			code_hash: string
			name: string
			scopes_json: string
			idle_ttl_seconds: number
			max_lifetime_seconds: number
			expires_at: string
			consumed_at: string | null
		}>()

	if (!row || !timingSafeEqualString(row.code_hash, codeHash)) {
		throw new McpCallerError('Invalid CLI bootstrap code.')
	}
	if (row.consumed_at) {
		throw new McpCallerError('CLI bootstrap code was already redeemed.')
	}
	if (Date.parse(row.expires_at) <= now.getTime()) {
		throw new McpCallerError('CLI bootstrap code expired.')
	}

	const consumedAt = now.toISOString()
	const burned = await input.db
		.prepare(
			`UPDATE cli_credential_bootstrap_codes
			 SET consumed_at = ?
			 WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
		)
		.bind(consumedAt, row.id, consumedAt)
		.run()
	if ((burned.meta.changes ?? 0) !== 1) {
		throw new McpCallerError('CLI bootstrap code was already redeemed.')
	}

	let scopes: Array<ApiTokenScope>
	try {
		scopes = normalizeApiTokenScopes(
			JSON.parse(row.scopes_json) as Array<unknown>,
		)
	} catch {
		throw new McpCallerError('Stored bootstrap scopes are invalid.')
	}

	const token = await mintApiToken({
		db: input.db,
		userId: row.user_id,
		name: row.name,
		scopes,
		idleTtlSeconds: row.idle_ttl_seconds,
		maxLifetimeSeconds: row.max_lifetime_seconds,
		createdVia: 'cli-bootstrap',
		now,
	})
	return { token, userId: row.user_id }
}
