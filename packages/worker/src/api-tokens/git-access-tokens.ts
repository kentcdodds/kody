import {
	formatGitAccessToken,
	generateApiTokenId,
	generateApiTokenSecret,
	parseGitAccessToken,
} from '@kody-internal/shared/api-token-format.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const gitAccessTokenPolicy = {
	/** Default and maximum lifetime for a minted git credential (~1h). */
	ttlSeconds: 60 * 60,
	minTtlSeconds: 60,
	maxTtlSeconds: 60 * 60,
	username: 'x',
} as const

export type GitAccessResourceKind = 'package' | 'repo'

export type GitAccessTokenRecord = {
	id: string
	user_id: string
	token_hash: string
	owner_handle: string
	repo_name: string
	resource_kind: GitAccessResourceKind
	resource_id: string
	resource_org_id: string
	expires_at: string
	created_at: string
	last_used_at: string | null
	revoked_at: string | null
}

export type GitAccessTokenSecretView = {
	protocol: 'https'
	host: string
	path: string
	username: string
	password: string
	expires_at: string
	resource_kind: GitAccessResourceKind
	owner_handle: string
	repo_name: string
}

async function hashSecret(secret: string) {
	return sha256Hex(secret)
}

function readResourceKind(value: unknown): GitAccessResourceKind {
	if (value === 'package' || value === 'repo') return value
	throw new Error(`Invalid git access token resource_kind: ${String(value)}`)
}

function mapRow(row: Record<string, unknown>): GitAccessTokenRecord {
	return {
		id: String(row.id),
		user_id: String(row.user_id),
		token_hash: String(row.token_hash),
		owner_handle: String(row.owner_handle),
		repo_name: String(row.repo_name),
		resource_kind: readResourceKind(row.resource_kind),
		resource_id: String(row.resource_id),
		resource_org_id: String(row.resource_org_id),
		expires_at: String(row.expires_at),
		created_at: String(row.created_at),
		last_used_at:
			typeof row.last_used_at === 'string' ? row.last_used_at : null,
		revoked_at: typeof row.revoked_at === 'string' ? row.revoked_at : null,
	}
}

export function gitAccessTokenIsActive(
	record: GitAccessTokenRecord,
	now: Date = new Date(),
) {
	if (record.revoked_at) return false
	return Date.parse(record.expires_at) > now.getTime()
}

/**
 * Mint a short-lived, single-repo git credential. Callers must already have
 * checked that `userId` can read the target resource.
 */
export async function mintGitAccessToken(input: {
	db: D1Database
	userId: string
	host: string
	path: string
	ownerHandle: string
	repoName: string
	resourceKind: GitAccessResourceKind
	resourceId: string
	resourceOrgId: string
	ttlSeconds?: number
	now?: Date
}): Promise<GitAccessTokenSecretView> {
	const now = input.now ?? new Date()
	const ttlSeconds = Math.min(
		gitAccessTokenPolicy.maxTtlSeconds,
		Math.max(
			gitAccessTokenPolicy.minTtlSeconds,
			input.ttlSeconds ?? gitAccessTokenPolicy.ttlSeconds,
		),
	)
	const tokenId = generateApiTokenId()
	const secret = generateApiTokenSecret()
	const nowIso = now.toISOString()
	const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
	const tokenHash = await hashSecret(secret)
	await input.db
		.prepare(
			`INSERT INTO git_access_tokens (
				id, user_id, token_hash, owner_handle, repo_name,
				resource_kind, resource_id, resource_org_id,
				expires_at, created_at, last_used_at, revoked_at, deleted_at, deleting_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
		)
		.bind(
			tokenId,
			input.userId,
			tokenHash,
			input.ownerHandle,
			input.repoName,
			input.resourceKind,
			input.resourceId,
			input.resourceOrgId,
			expiresAt,
			nowIso,
		)
		.run()

	const path = input.path.startsWith('/') ? input.path : `/${input.path}`
	return {
		protocol: 'https',
		host: input.host,
		path,
		username: gitAccessTokenPolicy.username,
		password: formatGitAccessToken({ tokenId, secret }),
		expires_at: expiresAt,
		resource_kind: input.resourceKind,
		owner_handle: input.ownerHandle,
		repo_name: input.repoName,
	}
}

export type GitAccessTokenAuthentication =
	| { ok: true; record: GitAccessTokenRecord }
	| { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'expired' }

export async function authenticateGitAccessToken(input: {
	db: D1Database
	token: string
	now?: Date
}): Promise<GitAccessTokenAuthentication> {
	const parsed = parseGitAccessToken(input.token)
	if (!parsed) return { ok: false, reason: 'malformed' }
	const row = await input.db
		.prepare(
			`SELECT * FROM git_access_tokens WHERE id = ? ${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(parsed.tokenId)
		.first<Record<string, unknown>>()
	if (!row) return { ok: false, reason: 'unknown' }
	const record = mapRow(row)
	const hashMatches = await timingSafeEqualString(
		await hashSecret(parsed.secret),
		record.token_hash,
	)
	if (!hashMatches) return { ok: false, reason: 'unknown' }
	if (record.revoked_at) return { ok: false, reason: 'revoked' }
	if (!gitAccessTokenIsActive(record, input.now ?? new Date())) {
		return { ok: false, reason: 'expired' }
	}
	return { ok: true, record }
}

export async function touchGitAccessToken(input: {
	db: D1Database
	tokenId: string
	now?: Date
}) {
	const nowIso = (input.now ?? new Date()).toISOString()
	await input.db
		.prepare(
			`UPDATE git_access_tokens
			 SET last_used_at = ?
			 WHERE id = ? AND revoked_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(nowIso, input.tokenId)
		.run()
}

/**
 * True when the credential is scoped to this owner/repo pair (case-insensitive
 * handle and repo leaf). Path may include or omit a leading slash and `.git`.
 */
export function gitAccessTokenMatchesRepo(input: {
	record: GitAccessTokenRecord
	ownerHandle: string
	repoName: string
}) {
	return (
		input.record.owner_handle.toLowerCase() ===
			input.ownerHandle.trim().toLowerCase() &&
		input.record.repo_name.toLowerCase() === input.repoName.trim().toLowerCase()
	)
}
