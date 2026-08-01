import {
	isDailyEntitlementResource,
	userMeterMirrorUpdatedAtToken,
	type DailyEntitlementResource,
	type UserMeterStorageBytesState,
} from '#worker/entitlements/user-meter-do.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'

type MeterRow = { count: number; revision: number }
type StorageRow = { bytes: number; revision: number; updatedAt: string }

/**
 * In-memory UserMeter stub keyed by `idFromName` (stable userId) for node-unit
 * coverage of expand-phase service/usage paths. Workers suites exercise the
 * real Durable Object binding instead.
 */
export function createInMemoryUserMeterEnv() {
	const metersByUser = new Map<string, Map<string, MeterRow>>()
	const storageByUser = new Map<string, StorageRow>()

	function counterKey(resource: string, day: string) {
		return `${resource}\0${day}`
	}

	function meterFor(userId: string) {
		const existingRows = metersByUser.get(userId)
		const rows = existingRows ?? new Map<string, MeterRow>()
		if (!existingRows) metersByUser.set(userId, rows)

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
			async purge() {
				rows.clear()
				storageByUser.delete(userId)
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
				const includeStorageShadow =
					typeof input.startAfter !== 'string' || input.startAfter.length === 0
				const storage = includeStorageShadow
					? storageByUser.get(userId)
					: undefined
				const storageBytesShadow: UserMeterStorageBytesState | null = storage
					? {
							bytes: storage.bytes,
							revision: storage.revision,
							updatedAt: storage.updatedAt,
							mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storage.revision),
						}
					: null
				return {
					counters,
					storageBytesShadow,
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
