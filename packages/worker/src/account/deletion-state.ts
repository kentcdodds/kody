import { AsyncLocalStorage } from 'node:async_hooks'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'

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

const accountDeletionShadowFailedLog =
	'account-deletion-user-meter-shadow-failed'

function scheduleAccountDeletionShadow(input: {
	env?: UserMeterEnv
	waitUntil?: (promise: Promise<unknown>) => void
	task: (env: UserMeterEnv) => Promise<void>
}): Promise<void> {
	const env = input.env
	if (!env || !userMeterNamespace(env)) return Promise.resolve()
	const tracked = input.task(env).catch((error: unknown) => {
		console.warn(accountDeletionShadowFailedLog, error)
	})
	if (input.waitUntil) input.waitUntil(tracked)
	return tracked
}

export async function markAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
	/** Optional expand-phase UserMeter shadow after a successful D1 mark. */
	env?: UserMeterEnv
	/** Prefer `ctx.waitUntil`; awaited (non-rejecting) when omitted. */
	waitUntil?: (promise: Promise<unknown>) => void
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
	const userRow = await input.db
		.prepare(
			`SELECT stable_user_id, deleting_at
			FROM users
			WHERE id = ?`,
		)
		.bind(input.dbUserId)
		.first<{ stable_user_id: string; deleting_at: string | null }>()
	const stableUserId = userRow?.stable_user_id
	const deletingAt = userRow?.deleting_at
	// Authoritative active D1 leases after deleting_at is set (new acquires
	// are fenced). Returned count stays D1-authoritative for drain waits.
	const activeLeases = stableUserId
		? await listActiveAccountWriteLeases(input.db, stableUserId)
		: []
	if (
		input.env &&
		userMeterNamespace(input.env) &&
		stableUserId &&
		deletingAt
	) {
		const markShadowPromise = scheduleAccountDeletionShadow({
			env: input.env,
			waitUntil: input.waitUntil,
			task: async (env) => {
				// Replace (not append) so a prior failed shadow release cannot
				// leave stale rows after D1 drain; empty list clears shadows.
				await userMeterRpc({
					env,
					userId: stableUserId,
				}).shadowReplaceDeletionState({
					deletingAt,
					leases: activeLeases.map((lease) => ({
						token: lease.token,
						holder: lease.holder,
						acquiredAt: lease.acquired_at,
					})),
				})
			},
		})
		if (!input.waitUntil) await markShadowPromise
	}
	return activeLeases.length
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

/**
 * Live lease frames keyed by stable user id, propagated down the current
 * async call chain. Nested {@link withAccountWriteLease} calls for the same
 * user reuse the outer lease while its frame is still active instead of
 * paying another acquire/release round trip to D1 (~5 statements each): the
 * outer lease spans the nested write, so deletion stays blocked for exactly
 * as long as it does today. MCP requests, app requests, job runs, and
 * package invocations all take a lease at their boundary, so before this
 * reuse a single execute call that invoked one package export paid for two
 * full leases.
 *
 * Frames deactivate when the outer lease releases. Detached work (for
 * example `waitUntil` callbacks spawned inside `write`) inherits this
 * AsyncLocalStorage context, and without the active flag it would keep
 * skipping acquisition after the lease row was already released.
 */
type AccountWriteLeaseFrame = { active: boolean }
const heldAccountWriteLeaseStorage = new AsyncLocalStorage<
	ReadonlyMap<string, AccountWriteLeaseFrame>
>()

export async function withAccountWriteLease<T>(input: {
	db: D1Database
	stableUserId: string
	holder?: string
	waitUntil?: (promise: Promise<unknown>) => void
	/** Optional expand-phase UserMeter shadow after D1 acquire/release. */
	env?: UserMeterEnv
	write: () => Promise<T>
}) {
	const heldLeases = heldAccountWriteLeaseStorage.getStore()
	if (heldLeases?.get(input.stableUserId)?.active) {
		return await input.write()
	}
	const frame: AccountWriteLeaseFrame = { active: true }
	const nextHeldLeases = new Map(heldLeases)
	nextHeldLeases.set(input.stableUserId, frame)
	try {
		return await heldAccountWriteLeaseStorage.run(nextHeldLeases, async () =>
			acquireAccountWriteLeaseAndWrite({ ...input, frame }),
		)
	} finally {
		frame.active = false
	}
}

async function acquireAccountWriteLeaseAndWrite<T>(input: {
	db: D1Database
	stableUserId: string
	holder?: string
	waitUntil?: (promise: Promise<unknown>) => void
	env?: UserMeterEnv
	frame: AccountWriteLeaseFrame
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
			input.frame.active = false
			const release = input.db
				.prepare(
					`UPDATE users
					SET active_write_count = MAX(active_write_count - 1, 0)
					WHERE stable_user_id = ?`,
				)
				.bind(input.stableUserId)
				.run()
			if (input.waitUntil) input.waitUntil(release)
			else await release
		}
	}
	const lease: AccountWriteLease = {
		token: crypto.randomUUID(),
		stableUserId: input.stableUserId,
		holder: input.holder ?? 'unspecified',
		acquiredAt: utcSqliteTimestamp(),
	}
	const prepareLeaseInsert = () =>
		input.db
			.prepare(
				`INSERT INTO account_write_leases (
					token, user_id, holder, acquired_at
				)
				SELECT ?, stable_user_id, ?, ?
				FROM users
				WHERE stable_user_id = ? AND deleting_at IS NULL`,
			)
			.bind(lease.token, lease.holder, lease.acquiredAt, lease.stableUserId)
	const prepareWriteCountIncrement = () =>
		input.db
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
	let inserted: D1Result<unknown>
	let counted: D1Result<unknown>
	try {
		const results = await input.db.batch([
			prepareLeaseInsert(),
			prepareWriteCountIncrement(),
		])
		if (!results[0] || !results[1]) {
			throw new Error('Account write lease batch returned incomplete results.')
		}
		inserted = results[0]
		counted = results[1]
	} catch {
		// A D1 batch can commit and still lose its response. Reconcile by token;
		// if it did not commit, retain the old sequential fallback so test and
		// local adapters that reject batch calls still preserve deletion fencing.
		const held = await input.db
			.prepare(
				`SELECT 1 AS held FROM account_write_leases
				WHERE token = ? AND user_id = ? AND released_at IS NULL`,
			)
			.bind(lease.token, lease.stableUserId)
			.first<{ held: number }>()
		if (held?.held === 1) {
			inserted = { meta: { changes: 1 } } as D1Result<unknown>
			counted = { meta: { changes: 1 } } as D1Result<unknown>
		} else {
			inserted = await prepareLeaseInsert().run()
			counted = await prepareWriteCountIncrement().run()
		}
	}
	if (
		(inserted?.meta.changes ?? 0) !== 1 ||
		(counted?.meta.changes ?? 0) !== 1
	) {
		throw new AccountDeletionInProgressError()
	}
	// Hold acquire so a detached release shadow cannot land first.
	const acquireShadowPromise = scheduleAccountDeletionShadow({
		env: input.env,
		waitUntil: input.waitUntil,
		task: async (env) => {
			await userMeterRpc({
				env,
				userId: lease.stableUserId,
			}).shadowAcquireWriteLease({
				token: lease.token,
				holder: lease.holder,
				acquiredAt: lease.acquiredAt,
			})
		},
	})
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
		input.frame.active = false
		const release = async () => {
			const prepareWriteCountDecrement = () =>
				input.db
					.prepare(
						`UPDATE users
					SET active_write_count = MAX(active_write_count - 1, 0)
					WHERE stable_user_id = ?
						AND EXISTS (
							SELECT 1 FROM account_write_leases
							WHERE token = ? AND user_id = ?
								AND released_at IS NULL
						)`,
					)
					.bind(lease.stableUserId, lease.token, lease.stableUserId)
			const prepareLeaseDelete = () =>
				input.db
					.prepare(
						`DELETE FROM account_write_leases
						WHERE token = ? AND user_id = ? AND released_at IS NULL`,
					)
					.bind(lease.token, lease.stableUserId)
			try {
				await input.db.batch([
					prepareWriteCountDecrement(),
					prepareLeaseDelete(),
				])
			} catch {
				const held = await input.db
					.prepare(
						`SELECT 1 AS held FROM account_write_leases
						WHERE token = ? AND user_id = ? AND released_at IS NULL`,
					)
					.bind(lease.token, lease.stableUserId)
					.first<{ held: number }>()
				if (held?.held !== 1) return
				const deleted = await prepareLeaseDelete().run()
				if ((deleted.meta.changes ?? 0) === 1) {
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
		const releasePromise = release()
		if (input.waitUntil) input.waitUntil(releasePromise)
		else await releasePromise
		// Ordered after D1 release; await when waitUntil is omitted.
		const releaseShadowPromise = scheduleAccountDeletionShadow({
			env: input.env,
			waitUntil: input.waitUntil,
			task: async (env) => {
				await releasePromise
				await acquireShadowPromise
				await userMeterRpc({
					env,
					userId: lease.stableUserId,
				}).shadowReleaseWriteLease({ token: lease.token })
			},
		})
		if (!input.waitUntil) await releaseShadowPromise
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
	/** Optional expand-phase UserMeter shadow after a successful D1 repair. */
	env?: UserMeterEnv
	/** Prefer `ctx.waitUntil`; awaited (non-rejecting) when omitted. */
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (input.reason.trim().length < 10) {
		throw new Error('Lease repair requires a detailed audit reason.')
	}
	const now = utcSqliteTimestamp()
	const repairId = crypto.randomUUID()
	const [audited, decremented, deleted] = await input.db.batch([
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
				`DELETE FROM account_write_leases
				WHERE token = ? AND user_id = ? AND acquired_at = ?
					AND released_at IS NULL`,
			)
			.bind(input.token, input.stableUserId, input.expectedAcquiredAt),
	])
	if (
		(audited?.meta.changes ?? 0) !== 1 ||
		(decremented?.meta.changes ?? 0) !== 1 ||
		(deleted?.meta.changes ?? 0) !== 1
	) {
		throw new Error('Active account write lease did not match repair request.')
	}
	const repairShadowPromise = scheduleAccountDeletionShadow({
		env: input.env,
		waitUntil: input.waitUntil,
		task: async (env) => {
			await userMeterRpc({
				env,
				userId: input.stableUserId,
			}).shadowReleaseWriteLease({ token: input.token })
		},
	})
	if (!input.waitUntil) await repairShadowPromise
	return { repaired: true as const, repairId }
}
