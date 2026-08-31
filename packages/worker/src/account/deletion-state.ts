import { AsyncLocalStorage } from 'node:async_hooks'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
	type UserMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import { runWithTransientDurableObjectResetRetry } from '#worker/durable-object-reset-retry.ts'

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

async function runUserMeterRpc<T>(input: {
	env: UserMeterEnv
	stableUserId: string
	operation: (meter: UserMeterRpc) => Promise<T>
}) {
	return await runWithTransientDurableObjectResetRetry({
		operation: async () =>
			await input.operation(
				userMeterRpc({
					env: input.env,
					userId: input.stableUserId,
				}),
			),
	})
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

export type MarkAccountDeletingResult = {
	leaseCount: number
	/** True when this invocation wrote `users.deleting_at`. */
	created: boolean
	deletingAt: string
}

export async function markAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
	env: UserMeterEnv
}): Promise<MarkAccountDeletingResult> {
	// D1 deleting_at is set first: it is the permanent point gate and must be
	// written before any UserMeter call so the gate is never missed even if
	// the DO call subsequently fails. Only roll back a tombstone this
	// invocation created (`WHERE deleting_at IS NULL`) so a concurrent or
	// retrying delete cannot wipe another attempt's fence.
	const now = utcSqliteTimestamp(input.now ?? new Date())
	const createResult = await input.db
		.prepare(
			`UPDATE users
			SET deleting_at = ?, updated_at = ?
			WHERE id = ? AND deleting_at IS NULL`,
		)
		.bind(now, now, input.dbUserId)
		.run()
	const created = (createResult.meta.changes ?? 0) === 1
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
	if (!stableUserId || !deletingAt) {
		throw new Error('Account could not be marked for deletion.')
	}
	try {
		const env = requireUserMeterEnv(input.env)
		const marked = await runUserMeterRpc({
			env,
			stableUserId,
			operation: async (meter) => await meter.markDeleting({ deletingAt }),
		})
		return {
			leaseCount: marked.leaseCount,
			created,
			deletingAt,
		}
	} catch (error) {
		if (created) {
			await input.db
				.prepare(
					`UPDATE users
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ? AND deleting_at = ?`,
				)
				.bind(now, input.dbUserId, now)
				.run()
		}
		throw error
	}
}

/**
 * Undo {@link markAccountDeleting} when deletion aborts before cleanup.
 * Clears D1 `users.deleting_at` first (permanent gate), then the UserMeter
 * tombstone. Pass `expectedDeletingAt` so a concurrent/retry fence is left
 * alone. A later write may still fail closed if the DO clear is delayed.
 */
export async function abortAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
	env: UserMeterEnv
	/**
	 * When set, clear D1 and UserMeter only if they still hold this exact
	 * fence. Omit for an operator abort of whatever leftover tombstone exists.
	 */
	expectedDeletingAt?: string
}) {
	const userRow = await input.db
		.prepare(
			`SELECT stable_user_id
			FROM users
			WHERE id = ?`,
		)
		.bind(input.dbUserId)
		.first<{ stable_user_id: string }>()
	const now = utcSqliteTimestamp(input.now ?? new Date())
	const result = input.expectedDeletingAt
		? await input.db
				.prepare(
					`UPDATE users
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ? AND deleting_at = ?`,
				)
				.bind(now, input.dbUserId, input.expectedDeletingAt)
				.run()
		: await input.db
				.prepare(
					`UPDATE users
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ?`,
				)
				.bind(now, input.dbUserId)
				.run()
	if (!input.expectedDeletingAt && (result.meta.changes ?? 0) !== 1) {
		throw new Error('Account deletion fence could not be cleared.')
	}
	const stableUserId = userRow?.stable_user_id
	if (!stableUserId) {
		throw new Error('Account deletion fence could not be cleared.')
	}
	const env = requireUserMeterEnv(input.env)
	await runUserMeterRpc({
		env,
		stableUserId,
		operation: async (meter) =>
			await meter.clearDeleting(
				input.expectedDeletingAt
					? { expectedDeletingAt: input.expectedDeletingAt }
					: undefined,
			),
	})
}

/**
 * Operator entry for {@link abortAccountDeleting}. Resolves `users.id` from
 * `stable_user_id` so admin tools never take the numeric D1 join key.
 */
export async function abortAccountDeletingByStableUserId(input: {
	db: D1Database
	stableUserId: string
	now?: Date
	env: UserMeterEnv
}) {
	const userRow = await input.db
		.prepare(
			`SELECT id
			FROM users
			WHERE stable_user_id = ?`,
		)
		.bind(input.stableUserId)
		.first<{ id: number }>()
	if (!userRow) {
		throw new Error('User not found.')
	}
	await abortAccountDeleting({
		db: input.db,
		dbUserId: userRow.id,
		now: input.now,
		env: input.env,
	})
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
 * paying another acquire/release round trip: the outer lease spans the nested
 * write, so deletion stays blocked for exactly as long as it does today. MCP
 * requests, app requests, job runs, and package invocations all take a lease
 * at their boundary, so before this reuse a single execute call that invoked
 * one package export paid for two full leases.
 *
 * Frames deactivate when the outer lease releases. Detached work (for
 * example callbacks spawned inside `write`) inherits this AsyncLocalStorage
 * context, and without the active flag it would keep skipping acquisition
 * after the lease row was already released.
 */
type AccountWriteLeaseFrame = { active: boolean }
const heldAccountWriteLeaseStorage = new AsyncLocalStorage<
	ReadonlyMap<string, AccountWriteLeaseFrame>
>()

export async function withAccountWriteLease<T>(input: {
	db: D1Database
	stableUserId: string
	holder?: string
	env: UserMeterEnv
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
		return await heldAccountWriteLeaseStorage.run(
			nextHeldLeases,
			async () =>
				await acquireDoAccountWriteLeaseAndWrite({
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
	const acquired = await runUserMeterRpc({
		env: input.env,
		stableUserId: lease.stableUserId,
		operation: async (meter) =>
			await meter.acquireWriteLease({
				token: lease.token,
				holder: lease.holder,
				acquiredAt: lease.acquiredAt,
			}),
	})
	if (!acquired.acquired) {
		throw new AccountDeletionInProgressError()
	}
	try {
		const result = await input.write()
		const held = await runUserMeterRpc({
			env: input.env,
			stableUserId: lease.stableUserId,
			operation: async (meter) =>
				await meter.assertWriteLeaseHeld({ token: lease.token }),
		})
		if (!held.held) throw new AccountWriteLeaseLostError()
		return result
	} finally {
		input.frame.active = false
		await runUserMeterRpc({
			env: input.env,
			stableUserId: lease.stableUserId,
			operation: async (meter) =>
				await meter.releaseWriteLease({ token: lease.token }),
		})
	}
}

export async function listActiveAccountWriteLeases(
	env: UserMeterEnv,
	stableUserId: string,
): Promise<Array<ListedAccountWriteLease>> {
	const requiredEnv = requireUserMeterEnv(env)
	const leases: Array<ListedAccountWriteLease> = []
	let startAfter: string | null = null
	for (;;) {
		const page = await runUserMeterRpc({
			env: requiredEnv,
			stableUserId,
			operation: async (meter) =>
				await meter.listWriteLeases({
					pageSize: 500,
					startAfter,
				}),
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

export async function repairAccountWriteLease(input: {
	db: D1Database
	stableUserId: string
	token: string
	expectedAcquiredAt: string
	repairedByUserId: string
	reason: string
	env: UserMeterEnv
}) {
	if (input.reason.trim().length < 10) {
		throw new Error('Lease repair requires a detailed audit reason.')
	}
	const reason = input.reason.trim()
	const env = requireUserMeterEnv(input.env)
	const prepared = await runUserMeterRpc({
		env,
		stableUserId: input.stableUserId,
		operation: async (meter) =>
			await meter.prepareWriteLeaseRepair({
				token: input.token,
				expectedAcquiredAt: input.expectedAcquiredAt,
			}),
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
		// Finalize DO lease; fail closed on transport errors (audit row persists for retry).
		await runUserMeterRpc({
			env,
			stableUserId: input.stableUserId,
			operation: async (meter) =>
				await meter.finalizeWriteLeaseRepair({
					token: prepared.token,
					repairId: prepared.repairId,
					expectedAcquiredAt: prepared.acquiredAt,
				}),
		})
		return { repaired: true as const, repairId: prepared.repairId }
	}
	// Lost-finalize retry: matching audit + absent DO lease → already repaired.
	const existingAudit = await findMatchingRepairAudit({
		db: input.db,
		stableUserId: input.stableUserId,
		token: input.token,
		expectedAcquiredAt: input.expectedAcquiredAt,
		repairedByUserId: input.repairedByUserId,
		reason,
	})
	if (existingAudit) {
		const stillHeld = await runUserMeterRpc({
			env,
			stableUserId: input.stableUserId,
			operation: async (meter) =>
				await meter.assertWriteLeaseHeld({
					token: input.token,
				}),
		})
		if (!stillHeld.held) {
			return { repaired: true as const, repairId: existingAudit.id }
		}
		throw new Error('Active account write lease did not match repair request.')
	}
	throw new Error('Active account write lease did not match repair request.')
}
