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

type ListedAccountWriteLease = {
	token: string
	holder: string
	acquired_at: string
}

function requireUserMeterEnv(env: UserMeterEnv) {
	if (!userMeterNamespace(env)) {
		throw new Error('USER_METER Durable Object binding is not configured.')
	}
	return env
}

async function listD1ActiveAccountWriteLeases(
	db: D1Database,
	stableUserId: string,
): Promise<Array<ListedAccountWriteLease>> {
	const rows = await db
		.prepare(
			`SELECT token, holder, acquired_at
			FROM account_write_leases
			WHERE user_id = ? AND released_at IS NULL
			ORDER BY acquired_at, token`,
		)
		.bind(stableUserId)
		.all<ListedAccountWriteLease>()
	return rows.results ?? []
}

async function listAllDoAuthorityWriteLeases(
	env: UserMeterEnv,
	stableUserId: string,
): Promise<Array<ListedAccountWriteLease>> {
	const meter = userMeterRpc({ env, userId: stableUserId })
	const leases: Array<ListedAccountWriteLease> = []
	let startAfter: string | null = null
	for (;;) {
		const page = await meter.listDoAuthorityWriteLeases({
			pageSize: 500,
			startAfter,
		})
		for (const lease of page.leases) {
			leases.push({
				token: lease.token,
				holder: lease.holder,
				acquired_at: lease.acquiredAt,
			})
		}
		if (!page.nextStartAfter) break
		startAfter = page.nextStartAfter
	}
	return leases
}

function unionActiveWriteLeases(
	d1Leases: ReadonlyArray<ListedAccountWriteLease>,
	doLeases: ReadonlyArray<ListedAccountWriteLease>,
): Array<ListedAccountWriteLease> {
	const byToken = new Map<string, ListedAccountWriteLease>()
	for (const lease of d1Leases) {
		byToken.set(lease.token, lease)
	}
	for (const lease of doLeases) {
		if (!byToken.has(lease.token)) byToken.set(lease.token, lease)
	}
	return [...byToken.values()].sort((left, right) => {
		const byAcquired = left.acquired_at.localeCompare(right.acquired_at)
		if (byAcquired !== 0) return byAcquired
		return left.token.localeCompare(right.token)
	})
}

/**
 * Acquire a D1 `account_write_leases` row for the legacy/email path. The
 * same atomic batch + lost-response reconcile protects against partial D1
 * batch responses. Not called from the DO-authority path after mirror
 * retirement.
 */
async function acquireD1WriteLeaseMirror(input: {
	db: D1Database
	lease: AccountWriteLease
}): Promise<boolean> {
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
			.bind(
				input.lease.token,
				input.lease.holder,
				input.lease.acquiredAt,
				input.lease.stableUserId,
			)
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
			.bind(
				input.lease.stableUserId,
				input.lease.token,
				input.lease.stableUserId,
			)
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
		const held = await input.db
			.prepare(
				`SELECT 1 AS held FROM account_write_leases
				WHERE token = ? AND user_id = ? AND released_at IS NULL`,
			)
			.bind(input.lease.token, input.lease.stableUserId)
			.first<{ held: number }>()
		if (held?.held === 1) {
			inserted = { meta: { changes: 1 } } as D1Result<unknown>
			counted = { meta: { changes: 1 } } as D1Result<unknown>
		} else {
			inserted = await prepareLeaseInsert().run()
			counted = await prepareWriteCountIncrement().run()
		}
	}
	return (
		(inserted?.meta.changes ?? 0) === 1 && (counted?.meta.changes ?? 0) === 1
	)
}

/**
 * Clear a legacy or historically stale D1 `account_write_leases` row.
 * Idempotent when the row is already gone (no count decrement). Used by the
 * legacy/email acquire path and by repair to clear pre-retirement stale rows.
 */
async function releaseD1WriteLeaseMirror(input: {
	db: D1Database
	stableUserId: string
	token: string
	expectedAcquiredAt?: string
}): Promise<{ released: boolean }> {
	const prepareWriteCountDecrement = () =>
		input.expectedAcquiredAt == null
			? input.db
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
					.bind(input.stableUserId, input.token, input.stableUserId)
			: input.db
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
					)
	const prepareLeaseDelete = () =>
		input.expectedAcquiredAt == null
			? input.db
					.prepare(
						`DELETE FROM account_write_leases
						WHERE token = ? AND user_id = ? AND released_at IS NULL`,
					)
					.bind(input.token, input.stableUserId)
			: input.db
					.prepare(
						`DELETE FROM account_write_leases
						WHERE token = ? AND user_id = ? AND acquired_at = ?
							AND released_at IS NULL`,
					)
					.bind(input.token, input.stableUserId, input.expectedAcquiredAt)
	try {
		const results = await input.db.batch([
			prepareWriteCountDecrement(),
			prepareLeaseDelete(),
		])
		return { released: (results[1]?.meta.changes ?? 0) === 1 }
	} catch {
		const held = await input.db
			.prepare(
				input.expectedAcquiredAt == null
					? `SELECT 1 AS held FROM account_write_leases
						WHERE token = ? AND user_id = ? AND released_at IS NULL`
					: `SELECT 1 AS held FROM account_write_leases
						WHERE token = ? AND user_id = ? AND acquired_at = ?
							AND released_at IS NULL`,
			)
			.bind(
				...(input.expectedAcquiredAt == null
					? [input.token, input.stableUserId]
					: [input.token, input.stableUserId, input.expectedAcquiredAt]),
			)
			.first<{ held: number }>()
		if (held?.held !== 1) return { released: false }
		const deleted = await prepareLeaseDelete().run()
		if ((deleted.meta.changes ?? 0) === 1) {
			await input.db
				.prepare(
					`UPDATE users
					SET active_write_count = MAX(active_write_count - 1, 0)
					WHERE stable_user_id = ?`,
				)
				.bind(input.stableUserId)
				.run()
			return { released: true }
		}
		return { released: false }
	}
}

async function insertOrVerifyDoRepairAudit(input: {
	db: D1Database
	repairId: string
	stableUserId: string
	token: string
	holder: string
	acquiredAt: string
	repairedByUserId: string
	reason: string
	now: string
}) {
	const inserted = await input.db
		.prepare(
			`INSERT OR IGNORE INTO account_write_lease_repairs (
				id, target_user_id, lease_token, lease_holder,
				lease_acquired_at, repaired_by_user_id, reason, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.repairId,
			input.stableUserId,
			input.token,
			input.holder,
			input.acquiredAt,
			input.repairedByUserId,
			input.reason,
			input.now,
		)
		.run()
	if ((inserted.meta.changes ?? 0) === 1) return
	const existing = await input.db
		.prepare(
			`SELECT target_user_id, lease_token, lease_holder, lease_acquired_at,
				repaired_by_user_id, reason
			FROM account_write_lease_repairs
			WHERE id = ?`,
		)
		.bind(input.repairId)
		.first<{
			target_user_id: string
			lease_token: string
			lease_holder: string
			lease_acquired_at: string
			repaired_by_user_id: string
			reason: string
		}>()
	if (
		!existing ||
		existing.target_user_id !== input.stableUserId ||
		existing.lease_token !== input.token ||
		existing.lease_holder !== input.holder ||
		existing.lease_acquired_at !== input.acquiredAt ||
		existing.repaired_by_user_id !== input.repairedByUserId ||
		existing.reason !== input.reason
	) {
		throw new Error('Active account write lease did not match repair request.')
	}
}

async function findMatchingRepairAudit(input: {
	db: D1Database
	stableUserId: string
	token: string
	expectedAcquiredAt: string
	repairedByUserId: string
	reason: string
}) {
	return await input.db
		.prepare(
			`SELECT id
			FROM account_write_lease_repairs
			WHERE target_user_id = ?
				AND lease_token = ?
				AND lease_acquired_at = ?
				AND repaired_by_user_id = ?
				AND reason = ?
			ORDER BY created_at DESC, id DESC
			LIMIT 1`,
		)
		.bind(
			input.stableUserId,
			input.token,
			input.expectedAcquiredAt,
			input.repairedByUserId,
			input.reason,
		)
		.first<{ id: string }>()
}

export async function markAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
	/**
	 * When supplied, UserMeter is authoritative for the deletion drain count
	 * (fail closed). When omitted, retain the exact D1 lease-count path.
	 */
	env?: UserMeterEnv
	/** Kept for API compatibility; DO mark is awaited. */
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
	const activeD1Leases = stableUserId
		? await listD1ActiveAccountWriteLeases(input.db, stableUserId)
		: []
	if (input.env === undefined) {
		return activeD1Leases.length
	}
	const env = requireUserMeterEnv(input.env)
	if (!stableUserId || !deletingAt) {
		throw new Error('Account could not be marked for deletion.')
	}
	const marked = await userMeterRpc({
		env,
		userId: stableUserId,
	}).markDeleting({
		deletingAt,
		legacyLeases: activeD1Leases.map((lease) => ({
			token: lease.token,
			holder: lease.holder,
			acquiredAt: lease.acquired_at,
		})),
	})
	return marked.leaseCount
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
 * paying another acquire/release round trip (~5 statements each on D1, or a
 * DO RPC pair when `env` is supplied): the outer lease spans the nested
 * write, so deletion stays blocked for exactly as long as it does today. MCP
 * requests, app requests, job runs, and package invocations all take a lease
 * at their boundary, so before this reuse a single execute call that invoked
 * one package export paid for two full leases.
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
	/**
	 * When supplied, UserMeter is authoritative for acquire/held/release
	 * (fail closed) after a D1 `deleting_at` point gate. When omitted, retain
	 * the exact D1 lease path (email/legacy callers).
	 */
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
			input.env === undefined
				? acquireD1AccountWriteLeaseAndWrite({ ...input, frame })
				: acquireDoAccountWriteLeaseAndWrite({
						...input,
						env: requireUserMeterEnv(input.env),
						frame,
					}),
		)
	} finally {
		frame.active = false
	}
}

async function acquireDoAccountWriteLeaseAndWrite<T>(input: {
	db: D1Database
	stableUserId: string
	holder?: string
	waitUntil?: (promise: Promise<unknown>) => void
	env: UserMeterEnv
	frame: AccountWriteLeaseFrame
	write: () => Promise<T>
}) {
	await assertAccountWritableDb(input.db, input.stableUserId)
	const lease: AccountWriteLease = {
		token: crypto.randomUUID(),
		stableUserId: input.stableUserId,
		holder: input.holder ?? 'unspecified',
		acquiredAt: utcSqliteTimestamp(),
	}
	const meter = userMeterRpc({
		env: input.env,
		userId: lease.stableUserId,
	})
	const acquired = await meter.acquireWriteLease({
		token: lease.token,
		holder: lease.holder,
		acquiredAt: lease.acquiredAt,
	})
	if (!acquired.acquired) {
		throw new AccountDeletionInProgressError()
	}
	try {
		const result = await input.write()
		const held = await meter.assertWriteLeaseHeld({ token: lease.token })
		if (!held.held) throw new AccountWriteLeaseLostError()
		return result
	} finally {
		input.frame.active = false
		const releasePromise = meter.releaseWriteLease({ token: lease.token })
		if (input.waitUntil) input.waitUntil(releasePromise)
		else await releasePromise
	}
}

async function acquireD1AccountWriteLeaseAndWrite<T>(input: {
	db: D1Database
	stableUserId: string
	holder?: string
	waitUntil?: (promise: Promise<unknown>) => void
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
	const mirrored = await acquireD1WriteLeaseMirror({ db: input.db, lease })
	if (!mirrored) {
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
		input.frame.active = false
		const releasePromise = releaseD1WriteLeaseMirror({
			db: input.db,
			stableUserId: lease.stableUserId,
			token: lease.token,
		})
		if (input.waitUntil) input.waitUntil(releasePromise)
		else await releasePromise
	}
}

export async function listActiveAccountWriteLeases(
	db: D1Database,
	stableUserId: string,
	env?: UserMeterEnv,
) {
	const d1Leases = await listD1ActiveAccountWriteLeases(db, stableUserId)
	if (env === undefined) return d1Leases
	const requiredEnv = requireUserMeterEnv(env)
	const doLeases = await listAllDoAuthorityWriteLeases(
		requiredEnv,
		stableUserId,
	)
	return unionActiveWriteLeases(d1Leases, doLeases)
}

export async function repairAccountWriteLease(input: {
	db: D1Database
	stableUserId: string
	token: string
	expectedAcquiredAt: string
	repairedByUserId: string
	reason: string
	/**
	 * When supplied, DO-authority leases use prepare → audit → finalize DO →
	 * clear any stale D1 row (fail closed). Never clear the D1 row while the
	 * DO lease remains held. D1-only leases keep the existing atomic batch.
	 * When omitted, retain the exact D1 repair path.
	 */
	env?: UserMeterEnv
	/** Kept for API compatibility; DO finalize is awaited. */
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (input.reason.trim().length < 10) {
		throw new Error('Lease repair requires a detailed audit reason.')
	}
	const reason = input.reason.trim()
	if (input.env !== undefined) {
		const env = requireUserMeterEnv(input.env)
		const meter = userMeterRpc({ env, userId: input.stableUserId })
		const prepared = await meter.prepareWriteLeaseRepair({
			token: input.token,
			expectedAcquiredAt: input.expectedAcquiredAt,
		})
		if (prepared.prepared) {
			const now = utcSqliteTimestamp()
			await insertOrVerifyDoRepairAudit({
				db: input.db,
				repairId: prepared.repairId,
				stableUserId: input.stableUserId,
				token: prepared.token,
				holder: prepared.holder,
				acquiredAt: prepared.acquiredAt,
				repairedByUserId: input.repairedByUserId,
				reason,
				now,
			})
			// Finalize DO before clearing any stale D1 row; failed finalize leaves both held.
			await meter.finalizeWriteLeaseRepair({
				token: prepared.token,
				repairId: prepared.repairId,
				expectedAcquiredAt: prepared.acquiredAt,
			})
			await releaseD1WriteLeaseMirror({
				db: input.db,
				stableUserId: input.stableUserId,
				token: prepared.token,
				expectedAcquiredAt: prepared.acquiredAt,
			})
			return { repaired: true as const, repairId: prepared.repairId }
		}
		// Lost-finalize retry: matching audit + absent DO lease clears stale D1 mirror.
		const existingAudit = await findMatchingRepairAudit({
			db: input.db,
			stableUserId: input.stableUserId,
			token: input.token,
			expectedAcquiredAt: input.expectedAcquiredAt,
			repairedByUserId: input.repairedByUserId,
			reason,
		})
		if (existingAudit) {
			const stillHeld = await meter.assertWriteLeaseHeld({
				token: input.token,
			})
			if (!stillHeld.held) {
				await releaseD1WriteLeaseMirror({
					db: input.db,
					stableUserId: input.stableUserId,
					token: input.token,
					expectedAcquiredAt: input.expectedAcquiredAt,
				})
				return { repaired: true as const, repairId: existingAudit.id }
			}
			throw new Error(
				'Active account write lease did not match repair request.',
			)
		}
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
				reason,
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
	return { repaired: true as const, repairId }
}
