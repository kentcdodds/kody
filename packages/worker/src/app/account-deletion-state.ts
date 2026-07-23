import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'

export class AccountDeletionInProgressError extends Error {
	constructor() {
		super('Account deletion is in progress; user-owned writes are disabled.')
		this.name = 'AccountDeletionInProgressError'
	}
}

export class AccountDeletionWritersActiveError extends Error {
	readonly activeWriteCount: number

	constructor(activeWriteCount: number) {
		super(
			`Account deletion is waiting for ${activeWriteCount} active user write(s) to finish.`,
		)
		this.name = 'AccountDeletionWritersActiveError'
		this.activeWriteCount = activeWriteCount
	}
}

export class AccountWriteLeaseLostError extends Error {
	constructor() {
		super('Account write lease was released before the operation completed.')
		this.name = 'AccountWriteLeaseLostError'
	}
}

export type AccountWriteLease = {
	token: string
	stableUserId: string
	holder: string
	acquiredAt: string
}

export async function markAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
}) {
	const now = utcSqliteTimestamp(input.now ?? new Date())
	const result = await input.db
		.prepare(
			`UPDATE users
			SET deleting_at = COALESCE(deleting_at, ?), updated_at = ?
			WHERE id = ?`,
		)
		.bind(now, now, input.dbUserId)
		.run()
	if ((result.meta.changes ?? 0) !== 1) {
		throw new Error('Account could not be marked for deletion.')
	}
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM account_write_leases
			WHERE user_id = (
				SELECT stable_user_id FROM users WHERE id = ?
			) AND released_at IS NULL`,
		)
		.bind(input.dbUserId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function assertAccountWritableDb(
	db: D1Database,
	stableUserId: string,
) {
	const row = await db
		.prepare(`SELECT deleting_at FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ deleting_at: string | null }>()
	if (!row || row.deleting_at) {
		throw new AccountDeletionInProgressError()
	}
}

export async function assertAccountWritable(env: Env, stableUserId: string) {
	await assertAccountWritableDb(env.APP_DB, stableUserId)
}

export async function withAccountWriteLease<T>(input: {
	db: D1Database
	stableUserId: string
	holder?: string
	write: () => Promise<T>
}) {
	if (typeof input.db.batch !== 'function') {
		const acquired = await input.db
			.prepare(
				`UPDATE users
				SET active_write_count = active_write_count + 1
				WHERE stable_user_id = ? AND deleting_at IS NULL`,
			)
			.bind(input.stableUserId)
			.run()
		if ((acquired.meta.changes ?? 0) !== 1) {
			throw new AccountDeletionInProgressError()
		}
		try {
			return await input.write()
		} finally {
			await input.db
				.prepare(
					`UPDATE users
					SET active_write_count = MAX(active_write_count - 1, 0)
					WHERE stable_user_id = ?`,
				)
				.bind(input.stableUserId)
				.run()
		}
	}
	const lease: AccountWriteLease = {
		token: crypto.randomUUID(),
		stableUserId: input.stableUserId,
		holder: input.holder ?? 'unspecified',
		acquiredAt: utcSqliteTimestamp(),
	}
	const inserted = await input.db
		.prepare(
			`INSERT INTO account_write_leases (
				token, user_id, holder, acquired_at
			)
			SELECT ?, stable_user_id, ?, ?
			FROM users
			WHERE stable_user_id = ? AND deleting_at IS NULL`,
		)
		.bind(lease.token, lease.holder, lease.acquiredAt, lease.stableUserId)
		.run()
	const counted = await input.db
		.prepare(
			`UPDATE users
			SET active_write_count = active_write_count + 1
			WHERE stable_user_id = ?
				AND EXISTS (
					SELECT 1 FROM account_write_leases
					WHERE token = ? AND user_id = ?
						AND released_at IS NULL
				)`,
		)
		.bind(lease.stableUserId, lease.token, lease.stableUserId)
		.run()
	if (
		(inserted?.meta.changes ?? 0) !== 1 ||
		(counted?.meta.changes ?? 0) !== 1
	) {
		throw new AccountDeletionInProgressError()
	}
	try {
		const result = await input.write()
		const held = await input.db
			.prepare(
				`SELECT 1 AS held FROM account_write_leases
				WHERE token = ? AND user_id = ? AND released_at IS NULL`,
			)
			.bind(lease.token, lease.stableUserId)
			.first<{ held: number }>()
		if (held?.held !== 1) throw new AccountWriteLeaseLostError()
		return result
	} finally {
		const releasedAt = utcSqliteTimestamp()
		const released = await input.db
			.prepare(
				`UPDATE account_write_leases
				SET released_at = ?
				WHERE token = ? AND user_id = ? AND released_at IS NULL`,
			)
			.bind(releasedAt, lease.token, lease.stableUserId)
			.run()
		if ((released.meta.changes ?? 0) === 1) {
			await input.db
				.prepare(
					`UPDATE users
					SET active_write_count = MAX(active_write_count - 1, 0)
					WHERE stable_user_id = ?`,
				)
				.bind(lease.stableUserId)
				.run()
		}
	}
}

export async function listActiveAccountWriteLeases(
	db: D1Database,
	stableUserId: string,
) {
	const rows = await db
		.prepare(
			`SELECT token, holder, acquired_at
			FROM account_write_leases
			WHERE user_id = ? AND released_at IS NULL
			ORDER BY acquired_at, token`,
		)
		.bind(stableUserId)
		.all<{ token: string; holder: string; acquired_at: string }>()
	return rows.results ?? []
}

export async function repairAccountWriteLease(input: {
	db: D1Database
	stableUserId: string
	token: string
	expectedAcquiredAt: string
	repairedByUserId: string
	reason: string
}) {
	if (input.reason.trim().length < 10) {
		throw new Error('Lease repair requires a detailed audit reason.')
	}
	const now = utcSqliteTimestamp()
	const repairId = crypto.randomUUID()
	const [audited, decremented, released] = await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO account_write_lease_repairs (
					id, target_user_id, lease_token, lease_holder,
					lease_acquired_at, repaired_by_user_id, reason, created_at
				)
				SELECT ?, user_id, token, holder, acquired_at, ?, ?, ?
				FROM account_write_leases
				WHERE token = ? AND user_id = ? AND acquired_at = ?
					AND released_at IS NULL`,
			)
			.bind(
				repairId,
				input.repairedByUserId,
				input.reason.trim(),
				now,
				input.token,
				input.stableUserId,
				input.expectedAcquiredAt,
			),
		input.db
			.prepare(
				`UPDATE users
				SET active_write_count = MAX(active_write_count - 1, 0)
				WHERE stable_user_id = ?
					AND EXISTS (
						SELECT 1 FROM account_write_leases
						WHERE token = ? AND user_id = ?
							AND acquired_at = ? AND released_at IS NULL
					)`,
			)
			.bind(
				input.stableUserId,
				input.token,
				input.stableUserId,
				input.expectedAcquiredAt,
			),
		input.db
			.prepare(
				`UPDATE account_write_leases
				SET released_at = ?
				WHERE token = ? AND user_id = ? AND acquired_at = ?
					AND released_at IS NULL`,
			)
			.bind(now, input.token, input.stableUserId, input.expectedAcquiredAt),
	])
	if (
		(audited?.meta.changes ?? 0) !== 1 ||
		(decremented?.meta.changes ?? 0) !== 1 ||
		(released?.meta.changes ?? 0) !== 1
	) {
		throw new Error('Active account write lease did not match repair request.')
	}
	return { repaired: true as const, repairId }
}
