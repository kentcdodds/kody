import {
	isDailyEntitlementResource,
	isUserMeterPackageServiceStatus,
	userMeterMirrorUpdatedAtToken,
	userMeterPackageServiceStateStaleMs,
	type DailyEntitlementResource,
	type UserMeterPackageServiceState,
	type UserMeterPackageServiceStatus,
	type UserMeterStorageBytesState,
} from '#worker/entitlements/user-meter-do.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'

type MeterRow = { count: number; revision: number }
type StorageRow = { bytes: number; revision: number; updatedAt: string }
type PackageServiceRow = {
	status: UserMeterPackageServiceStatus
	startedAt: string | null
	sourceUpdatedAt: string
	revision: number
	updatedAt: string
}

/**
 * In-memory UserMeter stub keyed by `idFromName` (stable userId) for node-unit
 * coverage of expand-phase service/usage paths. Workers suites exercise the
 * real Durable Object binding instead.
 */
export function createInMemoryUserMeterEnv() {
	const metersByUser = new Map<string, Map<string, MeterRow>>()
	const storageByUser = new Map<string, StorageRow>()
	const packageServicesByUser = new Map<
		string,
		Map<string, PackageServiceRow>
	>()

	function counterKey(resource: string, day: string) {
		return `${resource}\0${day}`
	}

	function packageServiceKey(packageId: string, serviceName: string) {
		return `${packageId}\0${serviceName}`
	}

	function meterFor(userId: string) {
		const existingRows = metersByUser.get(userId)
		const rows = existingRows ?? new Map<string, MeterRow>()
		if (!existingRows) metersByUser.set(userId, rows)

		const existingPackageServices = packageServicesByUser.get(userId)
		const packageServices =
			existingPackageServices ?? new Map<string, PackageServiceRow>()
		if (!existingPackageServices) {
			packageServicesByUser.set(userId, packageServices)
		}

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

		function packageServiceState(
			packageId: string,
			serviceName: string,
			row: PackageServiceRow,
		): UserMeterPackageServiceState {
			return {
				packageId,
				serviceName,
				status: row.status,
				startedAt: row.status === 'running' ? row.startedAt : null,
				sourceUpdatedAt: row.sourceUpdatedAt,
				revision: row.revision,
				updatedAt: row.updatedAt,
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
			}
		}

		function listPackageServiceStatesSorted() {
			return [...packageServices.entries()]
				.map(([entryKey, row]) => {
					const [packageId, serviceName] = entryKey.split('\0')
					return packageServiceState(packageId!, serviceName!, row)
				})
				.sort((left, right) => {
					const byPackage = left.packageId.localeCompare(right.packageId)
					if (byPackage !== 0) return byPackage
					return left.serviceName.localeCompare(right.serviceName)
				})
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
			async upsertPackageServiceState(input: {
				packageId: string
				serviceName: string
				status: string
				startedAt?: string | null
				sourceUpdatedAt: string
				updatedAt?: string
			}) {
				if (!isUserMeterPackageServiceStatus(input.status)) {
					throw new Error(
						`UserMeter package service status must be running, idle, stopped, or error; got ${JSON.stringify(input.status)}.`,
					)
				}
				const status = input.status
				const key = packageServiceKey(input.packageId, input.serviceName)
				const existing = packageServices.get(key)
				if (existing && existing.sourceUpdatedAt > input.sourceUpdatedAt) {
					return {
						applied: false,
						created: false,
						state: packageServiceState(
							input.packageId,
							input.serviceName,
							existing,
						),
					}
				}
				const startedAt =
					status === 'running' &&
					typeof input.startedAt === 'string' &&
					input.startedAt.length > 0
						? input.startedAt
						: null
				const updatedAt =
					typeof input.updatedAt === 'string' && input.updatedAt.length > 0
						? input.updatedAt
						: input.sourceUpdatedAt
				const row: PackageServiceRow = {
					status,
					startedAt,
					sourceUpdatedAt: input.sourceUpdatedAt,
					revision: existing ? existing.revision + 1 : 1,
					updatedAt,
				}
				packageServices.set(key, row)
				return {
					applied: true,
					created: !existing,
					state: packageServiceState(input.packageId, input.serviceName, row),
				}
			},
			async deletePackageServiceState(input: {
				packageId: string
				serviceName: string
			}) {
				const deleted = packageServices.delete(
					packageServiceKey(input.packageId, input.serviceName),
				)
				return { deleted }
			},
			async listPackageServiceStates(
				input: {
					pageSize?: number
					startAfter?: string | null
				} = {},
			) {
				const pageSize =
					typeof input.pageSize === 'number' && Number.isFinite(input.pageSize)
						? Math.min(Math.max(Math.trunc(input.pageSize), 1), 500)
						: 100
				const all = listPackageServiceStatesSorted()
				let startIndex = 0
				if (
					typeof input.startAfter === 'string' &&
					input.startAfter.length > 0
				) {
					try {
						const parsed = JSON.parse(input.startAfter) as unknown
						if (
							Array.isArray(parsed) &&
							parsed.length === 2 &&
							typeof parsed[0] === 'string' &&
							typeof parsed[1] === 'string'
						) {
							const packageId = parsed[0]
							const serviceName = parsed[1]
							startIndex =
								all.findIndex(
									(row) =>
										row.packageId === packageId &&
										row.serviceName === serviceName,
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
					states: page,
					nextStartAfter:
						truncated && last
							? JSON.stringify([last.packageId, last.serviceName])
							: null,
					truncated,
				}
			},
			async countRunningPackageServices(
				input: {
					staleAfterMs?: number
					excludeService?: { packageId: string; serviceName: string }
					now?: string
				} = {},
			) {
				const now = input.now ? new Date(input.now) : new Date()
				const staleAfterMs =
					typeof input.staleAfterMs === 'number' &&
					Number.isFinite(input.staleAfterMs) &&
					input.staleAfterMs >= 0
						? Math.trunc(input.staleAfterMs)
						: userMeterPackageServiceStateStaleMs
				const freshAfter = new Date(now.valueOf() - staleAfterMs).toISOString()
				let count = 0
				for (const [entryKey, row] of packageServices) {
					if (row.status !== 'running') continue
					if (row.sourceUpdatedAt < freshAfter) continue
					if (input.excludeService) {
						const [packageId, serviceName] = entryKey.split('\0')
						if (
							packageId === input.excludeService.packageId &&
							serviceName === input.excludeService.serviceName
						) {
							continue
						}
					}
					count += 1
				}
				return { count }
			},
			async bootstrapPackageServiceStates(input: {
				states: ReadonlyArray<{
					packageId: string
					serviceName: string
					status: string
					startedAt?: string | null
					sourceUpdatedAt: string
					updatedAt?: string
				}>
			}) {
				let applied = 0
				let skipped = 0
				for (const state of input.states) {
					const result = await this.upsertPackageServiceState(state)
					if (result.applied) applied += 1
					else skipped += 1
				}
				return { applied, skipped }
			},
			async purge() {
				rows.clear()
				storageByUser.delete(userId)
				packageServices.clear()
				packageServicesByUser.delete(userId)
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
				const includeShadows =
					typeof input.startAfter !== 'string' || input.startAfter.length === 0
				const storage = includeShadows ? storageByUser.get(userId) : undefined
				const storageBytesShadow: UserMeterStorageBytesState | null = storage
					? {
							bytes: storage.bytes,
							revision: storage.revision,
							updatedAt: storage.updatedAt,
							mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storage.revision),
						}
					: null
				const packageServiceStatesShadow = includeShadows
					? listPackageServiceStatesSorted()
					: null
				return {
					counters,
					storageBytesShadow,
					packageServiceStatesShadow,
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
		packageServicesByUser,
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
