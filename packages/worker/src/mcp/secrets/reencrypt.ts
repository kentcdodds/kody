import { runD1WithRetry } from '#worker/d1-retry.ts'
import {
	decryptPlatformOauthClientSecret,
	decryptSecretValue,
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	encryptPlatformOauthClientSecret,
	encryptSecretValue,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	platformOauthAppContext,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
	userSecretContext,
} from './crypto.ts'

export const secretCiphertextTables = [
	'secret_entries',
	'platform_oauth_apps',
	'user_integrations',
	'user_oauth_apps',
] as const

export type SecretCiphertextTable = (typeof secretCiphertextTables)[number]

export type SecretReencryptTableResult = {
	scanned: number
	rewritten: number
	skippedConcurrent: number
	decryptFailed: number
	remaining: number
}

export type SecretReencryptDecryptFailure = {
	table: SecretCiphertextTable
	key: string
}

export type ReencryptLegacySecretCiphertextsInput = {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	dryRun?: boolean
	maxRows?: number
	pageSize?: number
}

export type ReencryptLegacySecretCiphertextsResult = {
	dryRun: boolean
	secretEntries: SecretReencryptTableResult
	platformOauthApps: SecretReencryptTableResult
	userIntegrations: SecretReencryptTableResult
	userOauthApps: SecretReencryptTableResult
	decryptFailures: Array<SecretReencryptDecryptFailure>
}

const defaultPageSize = 50
const defaultMaxRows = 500
const maxReportedDecryptFailures = 20
const versionedCiphertextPrefix = 'v2.%'

type SecretEntryLegacyRow = {
	bucket_id: string
	name: string
	user_id: string
	encrypted_value: string
}

type PlatformOauthLegacyRow = {
	slug: string
	client_secret_encrypted: string
}

type UserIntegrationLegacyRow = {
	user_id: string
	name: string
	access_token_encrypted: string | null
	refresh_token_encrypted: string | null
}

type UserOauthAppLegacyRow = {
	user_id: string
	slug: string
	client_secret_encrypted: string
}

type RewriteOutcome = 'rewritten' | 'skippedConcurrent' | 'decryptFailed'

function emptyTableResult(): SecretReencryptTableResult {
	return {
		scanned: 0,
		rewritten: 0,
		skippedConcurrent: 0,
		decryptFailed: 0,
		remaining: 0,
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
	result: SecretReencryptTableResult,
	outcome: RewriteOutcome,
) {
	result.scanned += 1
	switch (outcome) {
		case 'rewritten':
			result.rewritten += 1
			return
		case 'skippedConcurrent':
			result.skippedConcurrent += 1
			return
		case 'decryptFailed':
			result.decryptFailed += 1
			return
		default: {
			const exhaustive: never = outcome
			throw new Error(`Unhandled secret re-encrypt outcome: ${exhaustive}`)
		}
	}
}

function recordDecryptFailure(
	failures: Array<SecretReencryptDecryptFailure>,
	failure: SecretReencryptDecryptFailure,
) {
	if (failures.length >= maxReportedDecryptFailures) return
	failures.push(failure)
}

async function countRemaining(input: {
	db: D1Database
	sql: string
	bindings?: Array<string>
}): Promise<number> {
	const row = await runD1WithRetry(() =>
		input.db
			.prepare(input.sql)
			.bind(...(input.bindings ?? [versionedCiphertextPrefix]))
			.first<Record<string, unknown>>(),
	)
	return readCount(row, 'remaining')
}

async function rewritePayload(input: {
	dryRun: boolean
	decrypt: () => Promise<string>
	encrypt: (plaintext: string) => Promise<string>
	write: (nextPayload: string, previousPayload: string) => Promise<number>
	previousPayload: string
}): Promise<RewriteOutcome> {
	let plaintext: string
	try {
		plaintext = await input.decrypt()
	} catch {
		return 'decryptFailed'
	}
	if (input.dryRun) return 'rewritten'
	const nextPayload = await input.encrypt(plaintext)
	const changes = await input.write(nextPayload, input.previousPayload)
	return changes > 0 ? 'rewritten' : 'skippedConcurrent'
}

async function listSecretEntryPage(input: {
	db: D1Database
	afterBucketId: string
	afterName: string
	limit: number
}): Promise<Array<SecretEntryLegacyRow>> {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT e.bucket_id, e.name, e.encrypted_value, b.user_id
				FROM secret_entries e
				JOIN secret_buckets b ON b.id = e.bucket_id
				WHERE e.encrypted_value NOT LIKE ?
					AND (e.bucket_id > ? OR (e.bucket_id = ? AND e.name > ?))
				ORDER BY e.bucket_id, e.name
				LIMIT ?`,
			)
			.bind(
				versionedCiphertextPrefix,
				input.afterBucketId,
				input.afterBucketId,
				input.afterName,
				input.limit,
			)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => ({
		bucket_id: String(row['bucket_id'] ?? ''),
		name: String(row['name'] ?? ''),
		user_id: String(row['user_id'] ?? ''),
		encrypted_value: String(row['encrypted_value'] ?? ''),
	}))
}

async function listPlatformOauthPage(input: {
	db: D1Database
	afterSlug: string
	limit: number
}): Promise<Array<PlatformOauthLegacyRow>> {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT slug, client_secret_encrypted
				FROM platform_oauth_apps
				WHERE client_secret_encrypted IS NOT NULL
					AND client_secret_encrypted NOT LIKE ?
					AND slug > ?
				ORDER BY slug
				LIMIT ?`,
			)
			.bind(versionedCiphertextPrefix, input.afterSlug, input.limit)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => ({
		slug: String(row['slug'] ?? ''),
		client_secret_encrypted: String(row['client_secret_encrypted'] ?? ''),
	}))
}

async function updateSecretEntry(input: {
	db: D1Database
	bucketId: string
	name: string
	nextPayload: string
	previousPayload: string
}): Promise<number> {
	const now = new Date().toISOString()
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE secret_entries
				SET encrypted_value = ?, updated_at = ?
				WHERE bucket_id = ? AND name = ? AND encrypted_value = ?`,
			)
			.bind(
				input.nextPayload,
				now,
				input.bucketId,
				input.name,
				input.previousPayload,
			)
			.run(),
	)
	return Number(result.meta.changes ?? 0)
}

async function updatePlatformOauthApp(input: {
	db: D1Database
	slug: string
	nextPayload: string
	previousPayload: string
}): Promise<number> {
	const now = new Date().toISOString()
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE platform_oauth_apps
				SET client_secret_encrypted = ?, updated_at = ?
				WHERE slug = ? AND client_secret_encrypted = ?`,
			)
			.bind(input.nextPayload, now, input.slug, input.previousPayload)
			.run(),
	)
	return Number(result.meta.changes ?? 0)
}

async function listUserIntegrationPage(input: {
	db: D1Database
	afterUserId: string
	afterName: string
	limit: number
}): Promise<Array<UserIntegrationLegacyRow>> {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT user_id, name, access_token_encrypted, refresh_token_encrypted
				FROM user_integrations
				WHERE (
					(access_token_encrypted IS NOT NULL AND access_token_encrypted NOT LIKE ?)
					OR (refresh_token_encrypted IS NOT NULL AND refresh_token_encrypted NOT LIKE ?)
				)
					AND (user_id > ? OR (user_id = ? AND name > ?))
				ORDER BY user_id, name
				LIMIT ?`,
			)
			.bind(
				versionedCiphertextPrefix,
				versionedCiphertextPrefix,
				input.afterUserId,
				input.afterUserId,
				input.afterName,
				input.limit,
			)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => ({
		user_id: String(row['user_id'] ?? ''),
		name: String(row['name'] ?? ''),
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

async function listUserOauthAppPage(input: {
	db: D1Database
	afterUserId: string
	afterSlug: string
	limit: number
}): Promise<Array<UserOauthAppLegacyRow>> {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT user_id, slug, client_secret_encrypted
				FROM user_oauth_apps
				WHERE client_secret_encrypted IS NOT NULL
					AND client_secret_encrypted NOT LIKE ?
					AND (user_id > ? OR (user_id = ? AND slug > ?))
				ORDER BY user_id, slug
				LIMIT ?`,
			)
			.bind(
				versionedCiphertextPrefix,
				input.afterUserId,
				input.afterUserId,
				input.afterSlug,
				input.limit,
			)
			.all<Record<string, unknown>>(),
	)
	return (results ?? []).map((row) => ({
		user_id: String(row['user_id'] ?? ''),
		slug: String(row['slug'] ?? ''),
		client_secret_encrypted: String(row['client_secret_encrypted'] ?? ''),
	}))
}

function isLegacyCiphertext(payload: string | null): payload is string {
	return payload != null && !payload.startsWith('v2.')
}

async function updateUserIntegrationCiphertext(input: {
	db: D1Database
	userId: string
	name: string
	column: 'access_token_encrypted' | 'refresh_token_encrypted'
	nextPayload: string
	previousPayload: string
}): Promise<number> {
	const now = new Date().toISOString()
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE user_integrations
				SET ${input.column} = ?, updated_at = ?
				WHERE user_id = ? AND name = ? AND ${input.column} = ?`,
			)
			.bind(
				input.nextPayload,
				now,
				input.userId,
				input.name,
				input.previousPayload,
			)
			.run(),
	)
	return Number(result.meta.changes ?? 0)
}

async function updateUserOauthApp(input: {
	db: D1Database
	userId: string
	slug: string
	nextPayload: string
	previousPayload: string
}): Promise<number> {
	const now = new Date().toISOString()
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE user_oauth_apps
				SET client_secret_encrypted = ?, updated_at = ?
				WHERE user_id = ? AND slug = ? AND client_secret_encrypted = ?`,
			)
			.bind(
				input.nextPayload,
				now,
				input.userId,
				input.slug,
				input.previousPayload,
			)
			.run(),
	)
	return Number(result.meta.changes ?? 0)
}

/**
 * Format-upgrade pass for pre-AAD (2-part) secret ciphertexts. Decrypts via
 * the existing dual-read, re-encrypts as v2 with the owning identity AAD, and
 * writes back with an optimistic compare so a concurrent user rotation wins.
 * Rows that fail decryption are counted and left unchanged.
 */
export async function reencryptLegacySecretCiphertexts(
	input: ReencryptLegacySecretCiphertextsInput,
): Promise<ReencryptLegacySecretCiphertextsResult> {
	const dryRun = input.dryRun === true
	const pageSize = input.pageSize ?? defaultPageSize
	let remainingBudget = input.maxRows ?? defaultMaxRows
	const decryptFailures: Array<SecretReencryptDecryptFailure> = []
	const secretEntries = emptyTableResult()
	const platformOauthApps = emptyTableResult()
	const userIntegrations = emptyTableResult()
	const userOauthApps = emptyTableResult()
	const db = input.env.APP_DB

	let afterBucketId = ''
	let afterName = ''
	while (remainingBudget > 0) {
		const rows = await listSecretEntryPage({
			db,
			afterBucketId,
			afterName,
			limit: Math.min(pageSize, remainingBudget),
		})
		if (rows.length === 0) break
		for (const row of rows) {
			const outcome = await rewritePayload({
				dryRun,
				previousPayload: row.encrypted_value,
				decrypt: () =>
					decryptSecretValue(
						input.env,
						row.encrypted_value,
						userSecretContext(row.user_id),
					),
				encrypt: (plaintext) =>
					encryptSecretValue(
						input.env,
						plaintext,
						userSecretContext(row.user_id),
					),
				write: (nextPayload, previousPayload) =>
					updateSecretEntry({
						db,
						bucketId: row.bucket_id,
						name: row.name,
						nextPayload,
						previousPayload,
					}),
			})
			recordOutcome(secretEntries, outcome)
			if (outcome === 'decryptFailed') {
				recordDecryptFailure(decryptFailures, {
					table: 'secret_entries',
					key: `${row.bucket_id}/${row.name}`,
				})
			}
			remainingBudget -= 1
		}
		if (rows.length < pageSize) break
		const last = rows[rows.length - 1]!
		afterBucketId = last.bucket_id
		afterName = last.name
	}
	secretEntries.remaining = await countRemaining({
		db,
		sql: `SELECT COUNT(*) AS remaining
			FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE e.encrypted_value NOT LIKE ?`,
	})

	let afterSlug = ''
	while (remainingBudget > 0) {
		const rows = await listPlatformOauthPage({
			db,
			afterSlug,
			limit: Math.min(pageSize, remainingBudget),
		})
		if (rows.length === 0) break
		for (const row of rows) {
			const outcome = await rewritePayload({
				dryRun,
				previousPayload: row.client_secret_encrypted,
				decrypt: () =>
					decryptPlatformOauthClientSecret(
						input.env,
						row.client_secret_encrypted,
						platformOauthAppContext(row.slug),
					),
				encrypt: (plaintext) =>
					encryptPlatformOauthClientSecret(
						input.env,
						plaintext,
						platformOauthAppContext(row.slug),
					),
				write: (nextPayload, previousPayload) =>
					updatePlatformOauthApp({
						db,
						slug: row.slug,
						nextPayload,
						previousPayload,
					}),
			})
			recordOutcome(platformOauthApps, outcome)
			if (outcome === 'decryptFailed') {
				recordDecryptFailure(decryptFailures, {
					table: 'platform_oauth_apps',
					key: row.slug,
				})
			}
			remainingBudget -= 1
		}
		if (rows.length < pageSize) break
		afterSlug = rows[rows.length - 1]!.slug
	}
	platformOauthApps.remaining = await countRemaining({
		db,
		sql: `SELECT COUNT(*) AS remaining
			FROM platform_oauth_apps
			WHERE client_secret_encrypted IS NOT NULL
				AND client_secret_encrypted NOT LIKE ?`,
	})

	let afterIntegrationUserId = ''
	let afterIntegrationName = ''
	while (remainingBudget > 0) {
		const rows = await listUserIntegrationPage({
			db,
			afterUserId: afterIntegrationUserId,
			afterName: afterIntegrationName,
			limit: Math.min(pageSize, remainingBudget),
		})
		if (rows.length === 0) break
		for (const row of rows) {
			const context = userIntegrationCredentialContext(row.user_id, row.name)
			const columns = [
				{
					column: 'access_token_encrypted' as const,
					payload: row.access_token_encrypted,
					decrypt: decryptUserOauthAccessToken,
					encrypt: encryptUserOauthAccessToken,
				},
				{
					column: 'refresh_token_encrypted' as const,
					payload: row.refresh_token_encrypted,
					decrypt: decryptUserOauthRefreshToken,
					encrypt: encryptUserOauthRefreshToken,
				},
			]
			for (const column of columns) {
				if (!isLegacyCiphertext(column.payload) || remainingBudget <= 0) {
					continue
				}
				const previousPayload = column.payload!
				const outcome = await rewritePayload({
					dryRun,
					previousPayload,
					decrypt: () => column.decrypt(input.env, previousPayload, context),
					encrypt: (plaintext) => column.encrypt(input.env, plaintext, context),
					write: (nextPayload, previous) =>
						updateUserIntegrationCiphertext({
							db,
							userId: row.user_id,
							name: row.name,
							column: column.column,
							nextPayload,
							previousPayload: previous,
						}),
				})
				recordOutcome(userIntegrations, outcome)
				if (outcome === 'decryptFailed') {
					recordDecryptFailure(decryptFailures, {
						table: 'user_integrations',
						key: `${row.user_id}/${row.name}/${column.column}`,
					})
				}
				remainingBudget -= 1
			}
		}
		if (rows.length < pageSize) break
		const last = rows[rows.length - 1]!
		afterIntegrationUserId = last.user_id
		afterIntegrationName = last.name
	}
	userIntegrations.remaining = await countRemaining({
		db,
		sql: `SELECT (
				SUM(CASE
					WHEN access_token_encrypted IS NOT NULL
						AND access_token_encrypted NOT LIKE ?
					THEN 1 ELSE 0 END)
				+ SUM(CASE
					WHEN refresh_token_encrypted IS NOT NULL
						AND refresh_token_encrypted NOT LIKE ?
					THEN 1 ELSE 0 END)
			) AS remaining
			FROM user_integrations`,
		bindings: [versionedCiphertextPrefix, versionedCiphertextPrefix],
	})

	let afterUserOauthUserId = ''
	let afterUserOauthSlug = ''
	while (remainingBudget > 0) {
		const rows = await listUserOauthAppPage({
			db,
			afterUserId: afterUserOauthUserId,
			afterSlug: afterUserOauthSlug,
			limit: Math.min(pageSize, remainingBudget),
		})
		if (rows.length === 0) break
		for (const row of rows) {
			const outcome = await rewritePayload({
				dryRun,
				previousPayload: row.client_secret_encrypted,
				decrypt: () =>
					decryptUserOauthClientSecret(
						input.env,
						row.client_secret_encrypted,
						userOauthAppCredentialContext(row.user_id, row.slug),
					),
				encrypt: (plaintext) =>
					encryptUserOauthClientSecret(
						input.env,
						plaintext,
						userOauthAppCredentialContext(row.user_id, row.slug),
					),
				write: (nextPayload, previousPayload) =>
					updateUserOauthApp({
						db,
						userId: row.user_id,
						slug: row.slug,
						nextPayload,
						previousPayload,
					}),
			})
			recordOutcome(userOauthApps, outcome)
			if (outcome === 'decryptFailed') {
				recordDecryptFailure(decryptFailures, {
					table: 'user_oauth_apps',
					key: `${row.user_id}/${row.slug}`,
				})
			}
			remainingBudget -= 1
		}
		if (rows.length < pageSize) break
		const last = rows[rows.length - 1]!
		afterUserOauthUserId = last.user_id
		afterUserOauthSlug = last.slug
	}
	userOauthApps.remaining = await countRemaining({
		db,
		sql: `SELECT COUNT(*) AS remaining
			FROM user_oauth_apps
			WHERE client_secret_encrypted IS NOT NULL
				AND client_secret_encrypted NOT LIKE ?`,
	})

	return {
		dryRun,
		secretEntries,
		platformOauthApps,
		userIntegrations,
		userOauthApps,
		decryptFailures,
	}
}
