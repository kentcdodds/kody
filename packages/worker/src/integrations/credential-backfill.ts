import {
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
} from '#mcp/secrets/crypto.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'

const defaultPageSize = 50
const defaultMaxRows = 500
const maxReportedMissingSecrets = 20
const storageContext = { sessionId: null, appId: null, packageId: null }

const leftoverAccessPredicate = `access_token_secret_name IS NOT NULL
	AND TRIM(access_token_secret_name) != ''
	AND access_token_encrypted IS NULL`

const leftoverRefreshPredicate = `refresh_token_secret_name IS NOT NULL
	AND TRIM(refresh_token_secret_name) != ''
	AND refresh_token_encrypted IS NULL`

const leftoverClientSecretPredicate = `client_secret_secret_name IS NOT NULL
	AND TRIM(client_secret_secret_name) != ''
	AND client_secret_encrypted IS NULL`

export type CredentialBackfillMissingReason =
	| 'not_found'
	| 'unreadable'
	| 'empty'

export type CredentialBackfillMissingSecret = {
	table: 'user_integrations' | 'user_oauth_apps'
	key: string
	reason: CredentialBackfillMissingReason
}

export type CredentialBackfillFieldResult = {
	leftover: number
	scanned: number
	copied: number
	missingSecret: number
	skippedConcurrent: number
	remaining: number
}

export type BackfillIntegrationCredentialsInput = {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	dryRun?: boolean
	maxRows?: number
	pageSize?: number
}

export type BackfillIntegrationCredentialsResult = {
	dryRun: boolean
	userIntegrations: {
		access: CredentialBackfillFieldResult
		refresh: CredentialBackfillFieldResult
	}
	userOauthApps: {
		clientSecret: CredentialBackfillFieldResult
	}
	missingSecrets: Array<CredentialBackfillMissingSecret>
}

type LeftoverIntegrationRow = {
	user_id: string
	name: string
	access_token_secret_name: string | null
	refresh_token_secret_name: string | null
	access_token_encrypted: string | null
	refresh_token_encrypted: string | null
}

type LeftoverOauthAppRow = {
	user_id: string
	slug: string
	client_secret_secret_name: string | null
	client_secret_encrypted: string | null
}

type CopyOutcome = 'copied' | 'skippedConcurrent' | 'missingSecret'

function emptyFieldResult(leftover = 0): CredentialBackfillFieldResult {
	return {
		leftover,
		scanned: 0,
		copied: 0,
		missingSecret: 0,
		skippedConcurrent: 0,
		remaining: leftover,
	}
}

function readCount(row: Record<string, unknown> | null, column: string) {
	const value = row?.[column]
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'bigint') return Number(value)
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : 0
	}
	return 0
}

function recordOutcome(
	result: CredentialBackfillFieldResult,
	outcome: CopyOutcome,
) {
	result.scanned += 1
	switch (outcome) {
		case 'copied':
			result.copied += 1
			return
		case 'skippedConcurrent':
			result.skippedConcurrent += 1
			return
		case 'missingSecret':
			result.missingSecret += 1
			return
		default: {
			const exhaustive: never = outcome
			throw new Error(`Unhandled credential backfill outcome: ${exhaustive}`)
		}
	}
}

function recordMissingSecret(
	missingSecrets: Array<CredentialBackfillMissingSecret>,
	missing: CredentialBackfillMissingSecret,
) {
	if (missingSecrets.length >= maxReportedMissingSecrets) return
	missingSecrets.push(missing)
}

function isNonEmptyName(value: string | null | undefined): value is string {
	return Boolean(value && value.trim() !== '')
}

function isLeftoverCiphertext(
	secretName: string | null | undefined,
	encrypted: string | null | undefined,
): secretName is string {
	return isNonEmptyName(secretName) && !encrypted
}

async function countColumn(input: {
	db: D1Database
	sql: string
	column: string
}): Promise<number> {
	const row = await runD1WithRetry(() =>
		input.db.prepare(input.sql).first<Record<string, unknown>>(),
	)
	return readCount(row, input.column)
}

async function countLeftovers(db: D1Database) {
	const [leftoverAccess, leftoverRefresh, leftoverClientSecret] =
		await Promise.all([
			countColumn({
				db,
				sql: `SELECT COUNT(*) AS leftover
					FROM user_integrations
					WHERE ${leftoverAccessPredicate}`,
				column: 'leftover',
			}),
			countColumn({
				db,
				sql: `SELECT COUNT(*) AS leftover
					FROM user_integrations
					WHERE ${leftoverRefreshPredicate}`,
				column: 'leftover',
			}),
			countColumn({
				db,
				sql: `SELECT COUNT(*) AS leftover
					FROM user_oauth_apps
					WHERE ${leftoverClientSecretPredicate}`,
				column: 'leftover',
			}),
		])
	return { leftoverAccess, leftoverRefresh, leftoverClientSecret }
}

async function listLeftoverIntegrationPage(input: {
	db: D1Database
	afterUserId: string
	afterName: string
	limit: number
}): Promise<Array<LeftoverIntegrationRow>> {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT user_id, name,
					access_token_secret_name, refresh_token_secret_name,
					access_token_encrypted, refresh_token_encrypted
				FROM user_integrations
				WHERE (
					(${leftoverAccessPredicate})
					OR (${leftoverRefreshPredicate})
				)
					AND (user_id > ? OR (user_id = ? AND name > ?))
				ORDER BY user_id, name
				LIMIT ?`,
			)
			.bind(input.afterUserId, input.afterUserId, input.afterName, input.limit)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => ({
		user_id: String(row['user_id'] ?? ''),
		name: String(row['name'] ?? ''),
		access_token_secret_name:
			typeof row['access_token_secret_name'] === 'string'
				? row['access_token_secret_name']
				: null,
		refresh_token_secret_name:
			typeof row['refresh_token_secret_name'] === 'string'
				? row['refresh_token_secret_name']
				: null,
		access_token_encrypted:
			typeof row['access_token_encrypted'] === 'string'
				? row['access_token_encrypted']
				: null,
		refresh_token_encrypted:
			typeof row['refresh_token_encrypted'] === 'string'
				? row['refresh_token_encrypted']
				: null,
	}))
}

async function listLeftoverOauthAppPage(input: {
	db: D1Database
	afterUserId: string
	afterSlug: string
	limit: number
}): Promise<Array<LeftoverOauthAppRow>> {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT user_id, slug, client_secret_secret_name, client_secret_encrypted
				FROM user_oauth_apps
				WHERE ${leftoverClientSecretPredicate}
					AND (user_id > ? OR (user_id = ? AND slug > ?))
				ORDER BY user_id, slug
				LIMIT ?`,
			)
			.bind(input.afterUserId, input.afterUserId, input.afterSlug, input.limit)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => ({
		user_id: String(row['user_id'] ?? ''),
		slug: String(row['slug'] ?? ''),
		client_secret_secret_name:
			typeof row['client_secret_secret_name'] === 'string'
				? row['client_secret_secret_name']
				: null,
		client_secret_encrypted:
			typeof row['client_secret_encrypted'] === 'string'
				? row['client_secret_encrypted']
				: null,
	}))
}

async function updateNullCiphertext(input: {
	db: D1Database
	sql: string
	bindings: Array<string>
}): Promise<number> {
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(input.sql)
			.bind(...input.bindings)
			.run(),
	)
	return Number(result.meta.changes ?? 0)
}

async function resolveNamedSecret(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	userId: string
	secretName: string
}): Promise<
	| { ok: true; value: string }
	| { ok: false; reason: CredentialBackfillMissingReason }
> {
	try {
		const resolved = await resolveSecret({
			env: input.env,
			userId: input.userId,
			name: input.secretName,
			scope: 'user',
			storageContext,
		})
		if (!resolved.found) return { ok: false, reason: 'not_found' }
		const value = resolved.value?.trim() ?? ''
		if (value === '') return { ok: false, reason: 'empty' }
		return { ok: true, value }
	} catch {
		return { ok: false, reason: 'unreadable' }
	}
}

async function copyLeftoverField(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	dryRun: boolean
	userId: string
	secretName: string
	encrypt: (plaintext: string) => Promise<string>
	write: (nextPayload: string) => Promise<number>
	missing: CredentialBackfillMissingSecret
	missingSecrets: Array<CredentialBackfillMissingSecret>
}): Promise<CopyOutcome> {
	const resolved = await resolveNamedSecret({
		env: input.env,
		userId: input.userId,
		secretName: input.secretName,
	})
	if (!resolved.ok) {
		recordMissingSecret(input.missingSecrets, {
			...input.missing,
			reason: resolved.reason,
		})
		return 'missingSecret'
	}
	if (input.dryRun) return 'copied'
	const nextPayload = await input.encrypt(resolved.value)
	const changes = await input.write(nextPayload)
	return changes > 0 ? 'copied' : 'skippedConcurrent'
}

/**
 * Copy leftover integration-owned OAuth values from `secret_entries` onto the
 * connection/app ciphertext columns. Skips rows that already have ciphertext.
 * Writes only where the target column is still null so a concurrent persist
 * wins. The JSON result is counts plus stable row keys — never plaintext or
 * ciphertext.
 */
export async function backfillIntegrationCredentials(
	input: BackfillIntegrationCredentialsInput,
): Promise<BackfillIntegrationCredentialsResult> {
	const dryRun = input.dryRun === true
	const pageSize = input.pageSize ?? defaultPageSize
	let remainingBudget = input.maxRows ?? defaultMaxRows
	const db = input.env.APP_DB
	const missingSecrets: Array<CredentialBackfillMissingSecret> = []
	const starting = await countLeftovers(db)
	const access = emptyFieldResult(starting.leftoverAccess)
	const refresh = emptyFieldResult(starting.leftoverRefresh)
	const clientSecret = emptyFieldResult(starting.leftoverClientSecret)

	let afterUserId = ''
	let afterName = ''
	while (remainingBudget > 0) {
		const rows = await listLeftoverIntegrationPage({
			db,
			afterUserId,
			afterName,
			limit: Math.min(pageSize, remainingBudget),
		})
		if (rows.length === 0) break
		for (const row of rows) {
			remainingBudget -= 1
			if (
				isLeftoverCiphertext(
					row.access_token_secret_name,
					row.access_token_encrypted,
				)
			) {
				const outcome = await copyLeftoverField({
					env: input.env,
					dryRun,
					userId: row.user_id,
					secretName: row.access_token_secret_name,
					encrypt: (plaintext) =>
						encryptUserOauthAccessToken(
							input.env,
							plaintext,
							userIntegrationCredentialContext(row.user_id, row.name),
						),
					write: (nextPayload) =>
						updateNullCiphertext({
							db,
							sql: `UPDATE user_integrations
								SET access_token_encrypted = ?, updated_at = ?
								WHERE user_id = ? AND name = ?
									AND access_token_encrypted IS NULL`,
							bindings: [
								nextPayload,
								new Date().toISOString(),
								row.user_id,
								row.name,
							],
						}),
					missing: {
						table: 'user_integrations',
						key: `${row.user_id}:${row.name}:access`,
						reason: 'not_found',
					},
					missingSecrets,
				})
				recordOutcome(access, outcome)
			}
			if (
				isLeftoverCiphertext(
					row.refresh_token_secret_name,
					row.refresh_token_encrypted,
				)
			) {
				const outcome = await copyLeftoverField({
					env: input.env,
					dryRun,
					userId: row.user_id,
					secretName: row.refresh_token_secret_name,
					encrypt: (plaintext) =>
						encryptUserOauthRefreshToken(
							input.env,
							plaintext,
							userIntegrationCredentialContext(row.user_id, row.name),
						),
					write: (nextPayload) =>
						updateNullCiphertext({
							db,
							sql: `UPDATE user_integrations
								SET refresh_token_encrypted = ?, updated_at = ?
								WHERE user_id = ? AND name = ?
									AND refresh_token_encrypted IS NULL`,
							bindings: [
								nextPayload,
								new Date().toISOString(),
								row.user_id,
								row.name,
							],
						}),
					missing: {
						table: 'user_integrations',
						key: `${row.user_id}:${row.name}:refresh`,
						reason: 'not_found',
					},
					missingSecrets,
				})
				recordOutcome(refresh, outcome)
			}
		}
		const last = rows[rows.length - 1]
		if (!last) break
		afterUserId = last.user_id
		afterName = last.name
	}

	afterUserId = ''
	let afterSlug = ''
	while (remainingBudget > 0) {
		const rows = await listLeftoverOauthAppPage({
			db,
			afterUserId,
			afterSlug,
			limit: Math.min(pageSize, remainingBudget),
		})
		if (rows.length === 0) break
		for (const row of rows) {
			remainingBudget -= 1
			if (
				!isLeftoverCiphertext(
					row.client_secret_secret_name,
					row.client_secret_encrypted,
				)
			) {
				continue
			}
			const outcome = await copyLeftoverField({
				env: input.env,
				dryRun,
				userId: row.user_id,
				secretName: row.client_secret_secret_name,
				encrypt: (plaintext) =>
					encryptUserOauthClientSecret(
						input.env,
						plaintext,
						userOauthAppCredentialContext(row.user_id, row.slug),
					),
				write: (nextPayload) =>
					updateNullCiphertext({
						db,
						sql: `UPDATE user_oauth_apps
							SET client_secret_encrypted = ?, updated_at = ?
							WHERE user_id = ? AND slug = ?
								AND client_secret_encrypted IS NULL`,
						bindings: [
							nextPayload,
							new Date().toISOString(),
							row.user_id,
							row.slug,
						],
					}),
				missing: {
					table: 'user_oauth_apps',
					key: `${row.user_id}:${row.slug}:clientSecret`,
					reason: 'not_found',
				},
				missingSecrets,
			})
			recordOutcome(clientSecret, outcome)
		}
		const last = rows[rows.length - 1]
		if (!last) break
		afterUserId = last.user_id
		afterSlug = last.slug
	}

	const remaining = await countLeftovers(db)
	access.remaining = remaining.leftoverAccess
	refresh.remaining = remaining.leftoverRefresh
	clientSecret.remaining = remaining.leftoverClientSecret

	return {
		dryRun,
		userIntegrations: { access, refresh },
		userOauthApps: { clientSecret },
		missingSecrets,
	}
}
