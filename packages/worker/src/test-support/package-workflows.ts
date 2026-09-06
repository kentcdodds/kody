import { vi } from 'vitest'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import { dynamicCallableWorkflowsBindingName } from './package-workflows.ts'

export const packageWorkflowsInvocationMocks = (() => ({
	invokePackageExport: vi.fn(),
	runModuleWithRegistry: vi.fn(),
	createExecutePackageInvokeTools: vi.fn(() => ({ invoke: vi.fn() })),
	createPackageRuntimeInvokeTools: vi.fn(() => ({ invoke: vi.fn() })),
}))()

export const packageWorkflowsRunRecordMocks = (() => {
	const projectionsByUser = new Map<
		string,
		Map<string, WorkflowProjectionRecord>
	>()
	const activeStatuses = new Set<string>([
		'queued',
		'running',
		'paused',
		'waiting',
		'waitingForPause',
		'unknown',
	])
	const reservationStatuses = new Set<string>([...activeStatuses, 'creating'])

	function userStore(userId: string) {
		let store = projectionsByUser.get(userId)
		if (!store) {
			store = new Map()
			projectionsByUser.set(userId, store)
		}
		return store
	}

	function toRecord(
		input: WorkflowProjectionUpsertInput,
		existing?: WorkflowProjectionRecord | null,
	): WorkflowProjectionRecord {
		const now = new Date().toISOString()
		return {
			id: input.id,
			bindingName: input.bindingName,
			sourceType: input.sourceType,
			packageId: input.packageId ?? null,
			kodyId: input.kodyId ?? null,
			sourceId: input.sourceId ?? null,
			workflowName: input.workflowName,
			exportName: input.exportName ?? null,
			idempotencyKey: input.idempotencyKey,
			runAt: input.runAt,
			planDate: input.planDate ?? null,
			status: input.status ?? null,
			createdAt: input.createdAt?.trim() || existing?.createdAt || now,
			updatedAt: input.updatedAt?.trim() || now,
			completedAt:
				input.completedAt === undefined
					? (existing?.completedAt ?? null)
					: input.completedAt,
			lastError:
				input.lastError === undefined
					? (existing?.lastError ?? null)
					: input.lastError,
		}
	}

	function applyProjectionUpsert(
		userId: string,
		projection: WorkflowProjectionUpsertInput,
	) {
		const store = userStore(userId)
		const existing = store.get(projection.id) ?? null
		const nextUpdatedAt =
			projection.updatedAt?.trim() || new Date().toISOString()
		if (!existing) {
			store.set(projection.id, toRecord(projection, null))
			return
		}
		// Monotonic by updatedAt + terminal stickiness (matches RunLog DO).
		if (nextUpdatedAt < existing.updatedAt) {
			return
		}
		const nextStatus = projection.status ?? null
		if (
			existing.status != null &&
			(terminalWorkflowStatusValues as ReadonlyArray<string>).includes(
				existing.status,
			) &&
			(nextStatus == null ||
				!(terminalWorkflowStatusValues as ReadonlyArray<string>).includes(
					nextStatus,
				))
		) {
			return
		}
		store.set(projection.id, {
			...existing,
			status: nextStatus,
			updatedAt: nextUpdatedAt,
			completedAt: projection.completedAt ?? existing.completedAt ?? null,
			lastError: projection.lastError ?? existing.lastError ?? null,
		})
	}

	const upsertWorkflowProjection = vi.fn(
		async (input: {
			env: Env
			userId: string
			projection: WorkflowProjectionUpsertInput
		}) => {
			applyProjectionUpsert(input.userId, input.projection)
			return { ok: true as const }
		},
	)

	return {
		projectionsByUser,
		resetProjections() {
			projectionsByUser.clear()
		},
		listForUser(userId: string) {
			return [...(projectionsByUser.get(userId)?.values() ?? [])]
		},
		beginRunRecord: vi.fn(() => ({
			id: 'run-1',
			userId: 'user-1',
			startedAt: '2026-05-03T12:34:56.000Z',
			persistence: 'eager' as const,
			context: { surface: 'workflow' as const },
		})),
		finishRunRecord: vi.fn(async () => {}),
		upsertWorkflowProjection,
		getWorkflowProjection: vi.fn(
			async (input: { env: Env; userId: string; id: string }) =>
				userStore(input.userId).get(input.id) ?? null,
		),
		findWorkflowProjectionByIdempotencyKey: vi.fn(
			async (input: {
				env: Env
				userId: string
				idempotencyKey: string
				bindingName?: string | null
			}) => {
				const matches = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							row.idempotencyKey === input.idempotencyKey &&
							row.status !== 'creating' &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				return matches[0] ?? null
			},
		),
		listWorkflowProjections: vi.fn(
			async (input: {
				env: Env
				userId: string
				limit?: number | null
				cursor?: string | null
				status?: string | null
				bindingName?: string | null
			}) => {
				const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
				const rows = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							(input.status ? row.status === input.status : true) &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
				return {
					projections: rows.slice(0, limit),
					nextCursor: null as string | null,
				}
			},
		),
		countActiveWorkflowProjections: vi.fn(
			async (input: { env: Env; userId: string }) =>
				[...userStore(input.userId).values()].filter(
					(row) => row.status != null && activeStatuses.has(row.status),
				).length,
		),
		reserveWorkflowProjectionSlot: vi.fn(
			async (input: {
				env: Env
				userId: string
				projection: WorkflowProjectionUpsertInput
			}) => {
				const store = userStore(input.userId)
				const existing = store.get(input.projection.id) ?? null
				const countBeforeReservation = [...store.values()].filter(
					(row) =>
						row.id !== input.projection.id &&
						row.status != null &&
						reservationStatuses.has(row.status),
				).length
				// Insert-only / creating-refresh: never clobber queued/running/terminal.
				if (
					existing?.status != null &&
					existing.status !== creatingWorkflowProjectionStatus
				) {
					return {
						countBeforeReservation,
						reserved: false,
						inserted: false,
						projection: existing,
					}
				}
				const now = new Date().toISOString()
				const inserted = existing == null
				// Keep count+insert synchronous (no await) so concurrent create
				// tests observe DO-like serialization under Promise.all.
				store.set(
					input.projection.id,
					toRecord(
						{
							...input.projection,
							status: 'creating',
							createdAt:
								input.projection.createdAt ?? existing?.createdAt ?? now,
							updatedAt: input.projection.updatedAt ?? now,
							completedAt: null,
							lastError: null,
						},
						existing,
					),
				)
				const projection = store.get(input.projection.id)
				if (!projection) {
					throw new Error('Expected reserved projection.')
				}
				return {
					countBeforeReservation,
					reserved: true,
					inserted,
					projection,
				}
			},
		),
		deleteWorkflowProjectionIfCreating: vi.fn(
			async (input: { env: Env; userId: string; id: string }) => {
				const store = userStore(input.userId)
				const existing = store.get(input.id)
				if (existing?.status === 'creating') {
					store.delete(input.id)
					return { deleted: true }
				}
				return { deleted: false }
			},
		),
	}
})()

export async function seedActiveWorkflowProjections(input: {
	userId: string
	count: number
}) {
	for (let index = 0; index < input.count; index += 1) {
		await packageWorkflowsRunRecordMocks.upsertWorkflowProjection({
			env: {} as Env,
			userId: input.userId,
			projection: {
				id: `active-seed-${input.userId}-${index}`,
				bindingName: dynamicCallableWorkflowsBindingName,
				sourceType: 'inline',
				workflowName: `seed-${index}`,
				idempotencyKey: `seed-key-${input.userId}-${index}`,
				runAt: '2026-05-03T12:34:56.000Z',
				status: 'queued',
			},
		})
	}
}

export function createWorkflowBinding(options?: {
	existing?: { id: string; status?: string } | null
	getThrows?: Error
	createThrows?: Error
	statusThrows?: Error
}) {
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (options?.createThrows) throw options.createThrows
		return {
			id: input.id,
			status: async () => {
				if (options?.statusThrows) throw options.statusThrows
				return { status: 'queued' }
			},
		}
	})
	const get = vi.fn(async (id: string) => {
		if (options?.getThrows) throw options.getThrows
		if (!options || options.existing === null) {
			throw new Error('workflow instance does not exist')
		}
		const existing = options.existing ?? { id, status: 'waiting' }
		return {
			id: existing.id,
			status: async () => {
				if (options.statusThrows) throw options.statusThrows
				return { status: existing.status ?? 'waiting' }
			},
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
	}
}

export function createStatefulWorkflowBinding() {
	const instances = new Map<string, WorkflowInstanceCreateOptions>()
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (instances.has(input.id)) {
			throw new Error('Workflow instance already exists')
		}
		instances.set(input.id, input)
		return {
			id: input.id,
			status: async () => ({ status: 'queued' }),
			terminate: vi.fn(async () => {}),
		}
	})
	const get = vi.fn(async (id: string) => {
		if (!instances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
			terminate: vi.fn(async () => {}),
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
		instances,
	}
}

/** APP_DB stub for entitlement plan lookup and saved-package ownership only. */
export function createWorkflowRunsDatabase(options?: {
	activeCount?: number
	savedPackage?: Record<string, unknown> | null
	users?: Array<{
		email: string
		plan: string | null
		stable_user_id?: string
	}>
}) {
	const savedPackage = options?.savedPackage ?? {
		id: 'pkg-1',
		user_id: 'user-1',
		name: 'Shade automation',
		kody_id: 'shade-automation',
		description: 'Shade automation package',
		tags_json: '[]',
		search_text: null,
		source_id: 'source-1',
		has_app: 0,
		created_at: '2026-05-03T00:00:00.000Z',
		updated_at: '2026-05-03T00:00:00.000Z',
	}
	const db = {
		prepare(query: string) {
			if (query.includes('workflow_runs')) {
				throw new Error(
					`Unexpected workflow_runs SQL after RunLog-only retirement: ${query}`,
				)
			}
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (query.includes('COUNT(*) AS count')) {
								return { count: options?.activeCount ?? 0 }
							}
							if (query.includes('SELECT plan, stripe_plan')) {
								if (query.includes('email = ?')) {
									const email = String(params[0] ?? '')
									const stableUserId = String(params[1] ?? '')
									const user = (options?.users ?? []).find(
										(row) =>
											row.email === email &&
											row.stable_user_id === stableUserId,
									)
									return user ? { plan: user.plan } : null
								}
								const stableUserId = String(params[0] ?? '')
								const user = (options?.users ?? []).find(
									(row) => row.stable_user_id === stableUserId,
								)
								return user ? { plan: user.plan } : null
							}
							if (query.includes('FROM saved_packages')) {
								if (!savedPackage) return null
								const userMatches = savedPackage['user_id'] === params[1]
								const idMatches =
									savedPackage['id'] === params[0] ||
									savedPackage['kody_id'] === params[0]
								return userMatches && idMatches ? savedPackage : null
							}
							return null
						},
						async all() {
							return { results: [] }
						},
						async run() {
							// Entitlement/usage helpers may touch APP_DB; only
							// workflow_runs lifecycle SQL is retired.
							return { success: true }
						},
					}
				},
			}
		},
	}
	return db as unknown as D1Database
}
