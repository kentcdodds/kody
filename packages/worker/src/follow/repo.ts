import {
	type FollowPushCommit,
	type FollowPushPending,
	type FollowRecord,
	type FollowStatus,
	type FollowTargetKind,
	isFollowTargetKind,
} from './types.ts'

export function hasAppDb(db: D1Database | undefined | null): db is D1Database {
	return Boolean(db && typeof db.prepare === 'function')
}

const followColumns = `id, follower_org_id, creator_user_id, target_kind,
	target_owner_id, target_id, target_name, status, paused_at,
	last_delivery_skip_reason, last_delivery_skip_at, created_at, updated_at`

function mapFollow(row: Record<string, unknown>): FollowRecord {
	const kind = String(row['target_kind'])
	if (!isFollowTargetKind(kind)) {
		throw new Error(`Invalid follow target kind: ${kind}`)
	}
	const status = String(row['status'])
	if (!isFollowStatus(status)) {
		throw new Error(`Invalid follow status: ${status}`)
	}
	return {
		id: String(row['id']),
		followerOrgId: String(row['follower_org_id']),
		creatorUserId: String(row['creator_user_id']),
		targetKind: kind,
		targetOwnerId: String(row['target_owner_id']),
		targetId: String(row['target_id']),
		targetName: String(row['target_name']),
		status,
		pausedAt: nullableString(row['paused_at']),
		lastDeliverySkipReason: nullableString(row['last_delivery_skip_reason']),
		lastDeliverySkipAt: nullableString(row['last_delivery_skip_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function isFollowStatus(value: string): value is FollowStatus {
	switch (value) {
		case 'active':
		case 'paused':
			return true
		default:
			return false
	}
}

function nullableString(value: unknown) {
	if (value == null) return null
	const text = String(value)
	return text === '' ? null : text
}

export async function insertFollow(
	db: D1Database,
	row: {
		id: string
		followerOrgId: string
		creatorUserId: string
		targetKind: FollowTargetKind
		targetOwnerId: string
		targetId: string
		targetName: string
		createdAt: string
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO follows (
				id, follower_org_id, creator_user_id, target_kind, target_owner_id,
				target_id, target_name, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		)
		.bind(
			row.id,
			row.followerOrgId,
			row.creatorUserId,
			row.targetKind,
			row.targetOwnerId,
			row.targetId,
			row.targetName,
			row.createdAt,
			row.createdAt,
		)
		.run()
}

export async function getFollowByTarget(
	db: D1Database,
	input: {
		followerOrgId: string
		targetKind: FollowTargetKind
		targetId: string
	},
): Promise<FollowRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE follower_org_id = ? AND target_kind = ? AND target_id = ?`,
		)
		.bind(input.followerOrgId, input.targetKind, input.targetId)
		.first<Record<string, unknown>>()
	return row ? mapFollow(row) : null
}

export async function listFollowsByFollower(
	db: D1Database,
	followerOrgId: string,
): Promise<Array<FollowRecord>> {
	const result = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE follower_org_id = ?
			ORDER BY created_at DESC, id ASC`,
		)
		.bind(followerOrgId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapFollow)
}

export async function listActiveFollowsByTarget(
	db: D1Database,
	input: { targetKind: FollowTargetKind; targetId: string },
): Promise<Array<FollowRecord>> {
	const result = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE target_kind = ? AND target_id = ? AND status = 'active'`,
		)
		.bind(input.targetKind, input.targetId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapFollow)
}

export async function pauseFollow(
	db: D1Database,
	input: { id: string; pausedAt: string },
): Promise<void> {
	await db
		.prepare(
			`UPDATE follows
			SET status = 'paused', paused_at = ?, updated_at = ?
			WHERE id = ? AND status = 'active'`,
		)
		.bind(input.pausedAt, input.pausedAt, input.id)
		.run()
}

export async function resumeFollow(
	db: D1Database,
	input: { id: string; updatedAt: string; creatorUserId: string },
): Promise<void> {
	await db
		.prepare(
			`UPDATE follows
			SET status = 'active', paused_at = NULL, creator_user_id = ?, updated_at = ?
			WHERE id = ? AND status = 'paused'`,
		)
		.bind(input.creatorUserId, input.updatedAt, input.id)
		.run()
}

/**
 * Active followAdd retargets delivery access to the caller who just passed
 * create checks. Returns false when the row is no longer active (for example
 * delivery paused it between the read and this write).
 */
export async function retargetFollowCreator(
	db: D1Database,
	input: { id: string; updatedAt: string; creatorUserId: string },
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE follows
			SET creator_user_id = ?, updated_at = ?
			WHERE id = ? AND status = 'active'`,
		)
		.bind(input.creatorUserId, input.updatedAt, input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function markFollowDeliverySkip(
	db: D1Database,
	input: { id: string; reason: string; skippedAt: string },
): Promise<void> {
	await db
		.prepare(
			`UPDATE follows
			SET last_delivery_skip_reason = ?, last_delivery_skip_at = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(input.reason, input.skippedAt, input.skippedAt, input.id)
		.run()
}

export async function deletePausedFollowsBefore(
	db: D1Database,
	cutoffIso: string,
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM follows
			WHERE status = 'paused' AND paused_at IS NOT NULL AND paused_at <= ?`,
		)
		.bind(cutoffIso)
		.run()
	return result.meta.changes ?? 0
}

function mapPending(row: Record<string, unknown>): FollowPushPending {
	const kind = String(row['target_kind'])
	if (!isFollowTargetKind(kind)) {
		throw new Error(`Invalid follow push target kind: ${kind}`)
	}
	return {
		targetKind: kind,
		targetId: String(row['target_id']),
		windowStartedAt: String(row['window_started_at']),
		beforeCommit: nullableString(row['before_commit']),
		afterCommit: nullableString(row['after_commit']),
		ref: String(row['ref']),
		commits: parseCommits(row['commits_json']),
		totalCommitsCount: Number(row['total_commits_count'] ?? 0),
		updatedAt: String(row['updated_at']),
	}
}

function parseCommits(value: unknown): Array<FollowPushCommit> {
	if (typeof value !== 'string' || !value) return []
	try {
		const parsed = JSON.parse(value) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter(isFollowPushCommit)
	} catch {
		return []
	}
}

function isFollowPushCommit(value: unknown): value is FollowPushCommit {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const record = value as Record<string, unknown>
	return typeof record['id'] === 'string'
}

export async function getFollowPushPending(
	db: D1Database,
	input: { targetKind: FollowTargetKind; targetId: string },
): Promise<FollowPushPending | null> {
	const row = await db
		.prepare(
			`SELECT target_kind, target_id, window_started_at, before_commit,
				after_commit, ref, commits_json, total_commits_count, updated_at
			FROM follow_push_pending
			WHERE target_kind = ? AND target_id = ?`,
		)
		.bind(input.targetKind, input.targetId)
		.first<Record<string, unknown>>()
	return row ? mapPending(row) : null
}

/**
 * Insert or replace the open window only when `expectedUpdatedAt` is still
 * the stored `updated_at` (`null` when the row is absent). A miss means a
 * concurrent push won the race; the caller re-reads and merges.
 */
export async function upsertFollowPushPending(
	db: D1Database,
	row: FollowPushPending,
	expectedUpdatedAt: string | null,
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO follow_push_pending (
				target_kind, target_id, window_started_at, before_commit, after_commit,
				ref, commits_json, total_commits_count, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (target_kind, target_id) DO UPDATE SET
				window_started_at = excluded.window_started_at,
				before_commit = excluded.before_commit,
				after_commit = excluded.after_commit,
				ref = excluded.ref,
				commits_json = excluded.commits_json,
				total_commits_count = excluded.total_commits_count,
				updated_at = excluded.updated_at
			WHERE follow_push_pending.updated_at = ?`,
		)
		.bind(
			row.targetKind,
			row.targetId,
			row.windowStartedAt,
			row.beforeCommit,
			row.afterCommit,
			row.ref,
			JSON.stringify(row.commits),
			row.totalCommitsCount,
			row.updatedAt,
			expectedUpdatedAt,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listDueFollowPushPending(
	db: D1Database,
	cutoffIso: string,
): Promise<Array<FollowPushPending>> {
	const result = await db
		.prepare(
			`SELECT target_kind, target_id, window_started_at, before_commit,
				after_commit, ref, commits_json, total_commits_count, updated_at
			FROM follow_push_pending
			WHERE window_started_at <= ?`,
		)
		.bind(cutoffIso)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapPending)
}

/** Deletes the flushed snapshot only when no newer write replaced it. */
export async function deleteFollowPushPendingIfUnchanged(
	db: D1Database,
	row: Pick<FollowPushPending, 'targetKind' | 'targetId' | 'updatedAt'>,
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM follow_push_pending
			WHERE target_kind = ? AND target_id = ? AND updated_at = ?`,
		)
		.bind(row.targetKind, row.targetId, row.updatedAt)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function ensureFollowTables(db: D1Database) {
	const statements = [
		`CREATE TABLE IF NOT EXISTS follows (
			id TEXT PRIMARY KEY NOT NULL,
			follower_org_id TEXT NOT NULL,
			creator_user_id TEXT NOT NULL,
			target_kind TEXT NOT NULL CHECK (target_kind IN ('package', 'repo')),
			target_owner_id TEXT NOT NULL,
			target_id TEXT NOT NULL,
			target_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'paused')) DEFAULT 'active',
			paused_at TEXT,
			last_delivery_skip_reason TEXT,
			last_delivery_skip_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (follower_org_id, target_kind, target_id)
		)`,
		`CREATE INDEX IF NOT EXISTS follows_target_idx
			ON follows (target_kind, target_id, status)`,
		`CREATE INDEX IF NOT EXISTS follows_paused_idx
			ON follows (status, paused_at)`,
		`CREATE INDEX IF NOT EXISTS follows_follower_idx
			ON follows (follower_org_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS follow_push_pending (
			target_kind TEXT NOT NULL CHECK (target_kind IN ('package', 'repo')),
			target_id TEXT NOT NULL,
			window_started_at TEXT NOT NULL,
			before_commit TEXT,
			after_commit TEXT,
			ref TEXT NOT NULL,
			commits_json TEXT NOT NULL,
			total_commits_count INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (target_kind, target_id)
		)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
