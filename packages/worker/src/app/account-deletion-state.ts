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
			`SELECT active_write_count, active_write_expires_at
			FROM users WHERE id = ?`,
		)
		.bind(input.dbUserId)
		.first<{
			active_write_count: number
			active_write_expires_at: string | null
		}>()
	const active =
		row?.active_write_expires_at && row.active_write_expires_at > now
			? Number(row.active_write_count)
			: 0
	if (active === 0 && Number(row?.active_write_count ?? 0) > 0) {
		await input.db
			.prepare(
				`UPDATE users
				SET active_write_count = 0, active_write_expires_at = NULL
				WHERE id = ?`,
			)
			.bind(input.dbUserId)
			.run()
	}
	return active
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
	write: () => Promise<T>
}) {
	const expiresAt = utcSqliteTimestamp(new Date(Date.now() + 30 * 60 * 1000))
	const acquired = await input.db
		.prepare(
			`UPDATE users
			SET active_write_count = active_write_count + 1,
				active_write_expires_at = ?
			WHERE stable_user_id = ? AND deleting_at IS NULL`,
		)
		.bind(expiresAt, input.stableUserId)
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
				SET active_write_count = MAX(active_write_count - 1, 0),
					active_write_expires_at = CASE
						WHEN active_write_count <= 1 THEN NULL
						ELSE active_write_expires_at
					END
				WHERE stable_user_id = ?`,
			)
			.bind(input.stableUserId)
			.run()
	}
}
