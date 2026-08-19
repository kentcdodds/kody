import {
	isDailyEntitlementResource,
	userMeterMirrorUpdatedAtToken,
	type DailyEntitlementResource,
	type UserMeterDeletionStateExport,
	type UserMeterStorageBytesState,
	type UserMeterWriteLeaseEntry,
} from '#worker/entitlements/user-meter-do.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'

type MeterRow = { count: number; revision: number }
type StorageRow = { bytes: number; revision: number; updatedAt: string }
type WriteLeaseRow = {
	holder: string
	acquiredAt: string
	pendingRepairId: string | null
}
type DeletionState = {
	deletingAt: string | null
	leases: Map<string, WriteLeaseRow>
}

/**
 * In-memory UserMeter stub keyed by `idFromName` (stable userId) for node-unit
 * coverage of authoritative usage paths. Workers suites exercise the real
 * Durable Object binding instead.
 */
export function createInMemoryUserMeterEnv() {
	const metersByUser = new Map<string, Map<string, MeterRow>>()
	const storageByUser = new Map<string, StorageRow>()
	const deletionByUser = new Map<string, DeletionState>()
	function counterKey(resource: string, day: string) {
		return `${resource}\0${day}`
	}

	function deletionStateFor(userId: string): DeletionState {
		const existing = deletionByUser.get(userId)
		if (existing) return existing
		const created: DeletionState = {
			deletingAt: null,
			leases: new Map(),
		}
		deletionByUser.set(userId, created)
		return created
	}

	function meterFor(userId: string) {
		const existingRows = metersByUser.get(userId)
		const rows = existingRows ?? new Map<string, MeterRow>()
		if (!existingRows) metersByUser.set(userId, rows)

		const deletion = deletionStateFor(userId)

		function readRow(resource: string, day: string) {
			return rows.get(counterKey(resource, day)) ?? null
		}

		function ready(row: MeterRow) {
			return {
				outcome: 'ready' as const,
				count: row.count,
				revision: row.revision,
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
			}
		}

		function storageReady(row: StorageRow) {
			return {
				outcome: 'ready' as const,
				bytes: row.bytes,
				revision: row.revision,
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
			}
		}

		function writeLeaseState(
			token: string,
			row: WriteLeaseRow,
		): UserMeterWriteLeaseEntry {
			return {
				token,
				holder: row.holder,
				acquiredAt: row.acquiredAt,
			}
		}

		function listWriteLeasesSorted() {
			return [...deletion.leases.entries()]
				.map(([token, row]) => writeLeaseState(token, row))
				.sort((left, right) => {
					const byAcquired = left.acquiredAt.localeCompare(right.acquiredAt)
					if (byAcquired !== 0) return byAcquired
					return left.token.localeCompare(right.token)
				})
		}

		function pageWriteLeases(input: {
			pageSize?: number
			startAfter?: string | null
		}) {
			const pageSize =
				typeof input.pageSize === 'number' && Number.isFinite(input.pageSize)
					? Math.min(Math.max(Math.trunc(input.pageSize), 1), 500)
					: 100
			const all = listWriteLeasesSorted()
			let startIndex = 0
			if (typeof input.startAfter === 'string' && input.startAfter.length > 0) {
				try {
					const parsed = JSON.parse(input.startAfter) as unknown
					if (
						Array.isArray(parsed) &&
						parsed.length === 2 &&
						typeof parsed[0] === 'string' &&
						typeof parsed[1] === 'string'
					) {
						const acquiredAt = parsed[0]
						const token = parsed[1]
						startIndex =
							all.findIndex(
								(row) => row.acquiredAt === acquiredAt && row.token === token,
							) + 1
					}
				} catch {
					startIndex = 0
				}
			}
			const page = all.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < all.length
			const last = page[page.length - 1]
			return {
				leases: page,
				nextStartAfter:
					truncated && last
						? JSON.stringify([last.acquiredAt, last.token])
						: null,
				truncated,
			}
		}

		function readDeletionStateExport(): UserMeterDeletionStateExport {
			const writeLeases = listWriteLeasesSorted().map((lease) => ({
				acquiredAt: lease.acquiredAt,
			}))
			return {
				deletingAt: deletion.deletingAt,
				activeWriteLeaseCount: writeLeases.length,
				writeLeases,
			}
		}

		return {
			async initialize(input: {
				resource: string
				day: string
				count: number
				updatedAt: string
			}) {
				if (!isDailyEntitlementResource(input.resource)) {
					throw new Error(`Invalid daily resource: ${input.resource}`)
				}
				const key = counterKey(input.resource, input.day)
				const existing = rows.get(key)
				if (existing) return { ...ready(existing), created: false }
				const row = {
					count: Math.max(0, Math.trunc(input.count) || 0),
					revision: 1,
				}
				rows.set(key, row)
				return { ...ready(row), created: true }
			},
			async consume(input: {
				resource: string
				day: string
				limit: number
				updatedAt: string
			}) {
				if (!isDailyEntitlementResource(input.resource)) {
					throw new Error(`Invalid daily resource: ${input.resource}`)
				}
				const resource: DailyEntitlementResource = input.resource
				const existing = readRow(resource, input.day)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				if (input.limit < 1 || existing.count + 1 > input.limit) {
					return { ...ready(existing), consumed: false }
				}
				const next = {
					count: existing.count + 1,
					revision: existing.revision + 1,
				}
				rows.set(counterKey(resource, input.day), next)
				return { ...ready(next), consumed: true }
			},
			async read(input: { resource: string; day: string }) {
				const existing = readRow(input.resource, input.day)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				return ready(existing)
			},
			async refund(input: {
				resource: string
				day: string
				updatedAt: string
			}) {
				const existing = readRow(input.resource, input.day)
				if (!existing) {
					return {
						outcome: 'ready' as const,
						count: 0,
						revision: 0,
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(0),
					}
				}
				const next = {
					count: Math.max(0, existing.count - 1),
					revision: existing.revision + 1,
				}
				rows.set(counterKey(input.resource, input.day), next)
				return ready(next)
			},
			async initializeStorageBytes(input: {
				bytes: number
				updatedAt: string
			}) {
				const existing = storageByUser.get(userId)
				if (existing) return { ...storageReady(existing), created: false }
				const row = {
					bytes: Math.max(0, Math.trunc(input.bytes) || 0),
					revision: 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, row)
				return { ...storageReady(row), created: true }
			},
			async readStorageBytes() {
				const existing = storageByUser.get(userId)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				return storageReady(existing)
			},
			async reserveStorageBytes(input: {
				requested: number
				limit: number
				updatedAt: string
			}) {
				const requested = Math.max(0, Math.trunc(input.requested) || 0)
				const existing = storageByUser.get(userId)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				if (
					requested > 0 &&
					(input.limit < 1 || existing.bytes + requested > input.limit)
				) {
					return { ...storageReady(existing), reserved: false }
				}
				if (requested === 0) {
					return { ...storageReady(existing), reserved: true }
				}
				const next = {
					bytes: existing.bytes + requested,
					revision: existing.revision + 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, next)
				return { ...storageReady(next), reserved: true }
			},
			async setStorageBytes(input: { bytes: number; updatedAt: string }) {
				const bytes = Math.max(0, Math.trunc(input.bytes) || 0)
				const existing = storageByUser.get(userId)
				if (!existing) {
					const row = { bytes, revision: 1, updatedAt: input.updatedAt }
					storageByUser.set(userId, row)
					return { ...storageReady(row), created: true }
				}
				const next = {
					bytes,
					revision: existing.revision + 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, next)
				return { ...storageReady(next), created: false }
			},
			async reconcileStorageBytes(input: {
				bytes: number
				expectedRevision: number
				updatedAt: string
			}) {
				const bytes = Math.max(0, Math.trunc(input.bytes) || 0)
				const existing = storageByUser.get(userId)
				if (!existing) {
					return { outcome: 'needs_bootstrap' as const }
				}
				if (existing.revision !== input.expectedRevision) {
					return { ...storageReady(existing), applied: false }
				}
				const next = {
					bytes,
					revision: existing.revision + 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, next)
				return { ...storageReady(next), applied: true }
			},
			async markDeleting(input: { deletingAt: string }) {
				const created = deletion.deletingAt == null
				if (created) deletion.deletingAt = input.deletingAt
				const leaseCount = deletion.leases.size
				return {
					deletingAt: deletion.deletingAt ?? input.deletingAt,
					created,
					leaseCount,
				}
			},
			async acquireWriteLease(input: {
				token: string
				holder: string
				acquiredAt: string
			}) {
				const existing = deletion.leases.get(input.token)
				if (existing) return { acquired: true }
				if (deletion.deletingAt != null) return { acquired: false }
				deletion.leases.set(input.token, {
					holder: input.holder,
					acquiredAt: input.acquiredAt,
					pendingRepairId: null,
				})
				return { acquired: true }
			},
			async releaseWriteLease(input: { token: string }) {
				return { released: deletion.leases.delete(input.token) }
			},
			async assertWriteLeaseHeld(input: { token: string }) {
				return { held: deletion.leases.has(input.token) }
			},
			async prepareWriteLeaseRepair(input: {
				token: string
				expectedAcquiredAt: string
			}) {
				const existing = deletion.leases.get(input.token)
				if (!existing) {
					return { prepared: false as const }
				}
				if (existing.acquiredAt !== input.expectedAcquiredAt) {
					throw new Error(
						'Active account write lease did not match repair request.',
					)
				}
				if (!existing.pendingRepairId) {
					existing.pendingRepairId = crypto.randomUUID()
				}
				return {
					prepared: true as const,
					repairId: existing.pendingRepairId,
					token: input.token,
					holder: existing.holder,
					acquiredAt: existing.acquiredAt,
				}
			},
			async finalizeWriteLeaseRepair(input: {
				token: string
				repairId: string
				expectedAcquiredAt: string
			}) {
				const existing = deletion.leases.get(input.token)
				if (!existing) return { finalized: true }
				if (
					existing.acquiredAt !== input.expectedAcquiredAt ||
					existing.pendingRepairId !== input.repairId
				) {
					throw new Error(
						'Active account write lease did not match repair request.',
					)
				}
				deletion.leases.delete(input.token)
				return { finalized: true }
			},
			async readDeletionState() {
				return { deletingAt: deletion.deletingAt }
			},
			async listWriteLeases(
				input: {
					pageSize?: number
					startAfter?: string | null
				} = {},
			) {
				return pageWriteLeases(input)
			},
			async countActiveWriteLeases() {
				return { count: deletion.leases.size }
			},
			async purge() {
				const deletingAt = deletion.deletingAt
				rows.clear()
				storageByUser.delete(userId)
				deletion.leases.clear()
				deletion.deletingAt = deletingAt
				return { ok: true as const }
			},
			async exportCounters(
				input: {
					pageSize?: number
					startAfter?: string | null
				} = {},
			) {
				const counters = [...rows.entries()].map(([entryKey, row]) => {
					const [resource, day] = entryKey.split('\0')
					return {
						resource: resource as DailyEntitlementResource,
						day: day!,
						count: row.count,
						revision: row.revision,
						updatedAt: new Date().toISOString(),
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
					}
				})
				const includeFirstPageState =
					typeof input.startAfter !== 'string' || input.startAfter.length === 0
				const storage = includeFirstPageState
					? storageByUser.get(userId)
					: undefined
				const storageBytesState: UserMeterStorageBytesState | null = storage
					? {
							bytes: storage.bytes,
							revision: storage.revision,
							updatedAt: storage.updatedAt,
							mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storage.revision),
						}
					: null
				const deletionState = includeFirstPageState
					? readDeletionStateExport()
					: null
				return {
					counters,
					storageBytesState,
					deletionState,
					nextStartAfter: null,
					truncated: false,
				}
			},
		}
	}

	const env = {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: (id: { name: string }) => meterFor(id.name),
		},
	} as unknown as UserMeterEnv

	return {
		env,
		metersByUser,
		storageByUser,
		deletionByUser,
		async seed(input: {
			userId: string
			resource: DailyEntitlementResource
			day: string
			count: number
		}) {
			await meterFor(input.userId).initialize({
				resource: input.resource,
				day: input.day,
				count: input.count,
				updatedAt: new Date().toISOString(),
			})
		},
		async seedStorageBytes(input: {
			userId: string
			bytes: number
			updatedAt?: string
		}) {
			await meterFor(input.userId).initializeStorageBytes({
				bytes: input.bytes,
				updatedAt: input.updatedAt ?? new Date().toISOString(),
			})
		},
	}
}

export function createWaitUntilDrain() {
	const tasks: Array<Promise<unknown>> = []
	return {
		waitUntil(promise: Promise<unknown>) {
			tasks.push(promise)
		},
		async drain() {
			await Promise.all(tasks)
			tasks.length = 0
		},
	}
}

/**
 * Minimal D1 stub for the `deleting_at` gate used by
 * {@link withAccountWriteLease} in node tests. The DO handles all lease
 * storage; the only D1 query on the hot path is the `deleting_at` point gate.
 */
export function createPermissiveAccountWriteLeaseDbHooks() {
	return {
		supportsDeletingAtQuery(query: string) {
			return query.includes(
				'SELECT deleting_at FROM users WHERE stable_user_id',
			)
		},
		deletingAtFirstResult() {
			return { deleting_at: null as string | null }
		},
	}
}

/**
 * Patch `db.prepare` and restore it via `using` even when the body throws.
 */
export function withPatchedDbPrepare(
	db: D1Database,
	patch: (originalPrepare: D1Database['prepare']) => D1Database['prepare'],
) {
	const originalPrepare = db.prepare.bind(db)
	db.prepare = patch(originalPrepare)
	return {
		[Symbol.dispose]() {
			db.prepare = originalPrepare
		},
	}
}
