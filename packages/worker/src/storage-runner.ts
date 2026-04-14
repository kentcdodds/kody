import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'

const defaultStorageExportPageSize = 250
const maxStorageExportPageSize = 1_000

type StorageEntry = {
	key: string
	value: unknown
}

type StorageExportResult = {
	entries: Array<StorageEntry>
	estimatedBytes: number
	truncated: boolean
	nextStartAfter: string | null
	pageSize: number
}

type StorageSqlValue = string | number | null

type StorageSqlResult = {
	columns: Array<string>
	rows: Array<Record<string, StorageSqlValue>>
	rowCount: number
	rowsRead: number
	rowsWritten: number
}

type StorageListResult = StorageExportResult

type StorageSetResult = {
	ok: true
	key: string
}

type StorageDeleteResult = {
	ok: true
	key: string
	deleted: boolean
}

type StorageClearResult = {
	ok: true
}

function buildStorageRunnerName(userId: string, storageId: string) {
	return `${userId}:${storageId}`
}

export function createExecuteStorageId() {
	return `exec:${crypto.randomUUID()}`
}

export function createJobStorageId(jobId: string) {
	return `job:${jobId}`
}

function normalizeStorageKey(key: string) {
	const trimmed = key.trim()
	if (!trimmed) {
		throw new Error('Storage key must be a non-empty string.')
	}
	return trimmed
}

function normalizePageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultStorageExportPageSize
	return Math.min(Math.max(requested, 1), maxStorageExportPageSize)
}

function normalizeSqlParams(params: Array<unknown> | undefined) {
	return (params ?? []).map((value) => {
		if (
			value === null ||
			typeof value === 'string' ||
			typeof value === 'number'
		) {
			return value
		}
		if (typeof value === 'boolean') {
			return value ? 1 : 0
		}
		throw new Error(
			'storage.sql params only support strings, numbers, booleans, and null.',
		)
	})
}

function assertSqlAllowed(query: string, writable: boolean | undefined) {
	const trimmed = query.trim()
	if (!trimmed) {
		throw new Error('storage.sql requires a non-empty query.')
	}
	if (writable) return trimmed
	const normalized = trimmed.toLowerCase()
	const allowedReadOnlyPrefixes = [
		'select',
		'explain',
		'pragma table_info(',
		'pragma index_list(',
		'pragma index_info(',
		'pragma database_list',
		'pragma table_list',
	] as const
	if (
		allowedReadOnlyPrefixes.some((prefix) => normalized.startsWith(prefix))
	) {
		return trimmed
	}
	throw new Error(
		'Read-only storage.sql only allows SELECT, EXPLAIN, and schema PRAGMA queries. Pass writable: true to allow mutations.',
	)
}

function cursorToSqlResult(
	cursor: SqlStorageCursor<Record<string, StorageSqlValue>>,
): StorageSqlResult {
	const rows = cursor.toArray()
	return {
		columns: [...cursor.columnNames],
		rows,
		rowCount: rows.length,
		rowsRead: cursor.rowsRead,
		rowsWritten: cursor.rowsWritten,
	}
}

class StorageRunnerBase extends DurableObject<Env> {
	async getValue(input: { key: string }) {
		const key = normalizeStorageKey(input.key)
		return {
			key,
			value: (await this.ctx.storage.get(key)) ?? null,
		}
	}

	async setValue(input: { key: string; value: unknown }): Promise<StorageSetResult> {
		const key = normalizeStorageKey(input.key)
		await this.ctx.storage.put(key, input.value)
		return { ok: true, key }
	}

	async deleteValue(input: { key: string }): Promise<StorageDeleteResult> {
		const key = normalizeStorageKey(input.key)
		const deleted = await this.ctx.storage.delete(key)
		return {
			ok: true,
			key,
			deleted,
		}
	}

	async clearStorage(): Promise<StorageClearResult> {
		await this.ctx.storage.deleteAll()
		return { ok: true }
	}

	async listValues(input: {
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}): Promise<StorageListResult> {
		const pageSize = normalizePageSize(input.pageSize)
		const prefix = input.prefix?.trim() || undefined
		const startAfter = input.startAfter?.trim() || undefined
		const listedEntries = await this.ctx.storage.list({
			...(prefix ? { prefix } : {}),
			...(startAfter ? { startAfter } : {}),
			limit: pageSize + 1,
		})
		const entries: Array<StorageEntry> = []
		let nextStartAfter: string | null = null
		let truncated = false
		for (const [key, value] of listedEntries) {
			if (entries.length === pageSize) {
				truncated = true
				break
			}
			entries.push({ key, value })
			nextStartAfter = key
		}
		return {
			entries,
			estimatedBytes: this.ctx.storage.sql.databaseSize,
			truncated,
			nextStartAfter: truncated ? nextStartAfter : null,
			pageSize,
		}
	}

	async exportStorage(input: {
		pageSize?: number
		startAfter?: string | null
	}) {
		return await this.listValues({
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	async sqlQuery(input: {
		query: string
		params?: Array<unknown>
		writable?: boolean
	}): Promise<StorageSqlResult> {
		const query = assertSqlAllowed(input.query, input.writable)
		const params = normalizeSqlParams(input.params)
		const cursor = this.ctx.storage.sql.exec<
			Record<string, StorageSqlValue>
		>(query, ...params)
		return cursorToSqlResult(cursor)
	}
}

export const StorageRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	StorageRunnerBase,
)

export function storageRunnerRpc(input: {
	env: Env
	userId: string
	storageId: string
}) {
	return input.env.STORAGE_RUNNER.get(
		input.env.STORAGE_RUNNER.idFromName(
			buildStorageRunnerName(input.userId, input.storageId),
		),
	) as unknown as {
		getValue: (payload: { key: string }) => Promise<{
			key: string
			value: unknown
		}>
		setValue: (payload: {
			key: string
			value: unknown
		}) => Promise<StorageSetResult>
		deleteValue: (payload: { key: string }) => Promise<StorageDeleteResult>
		clearStorage: () => Promise<StorageClearResult>
		listValues: (payload: {
			prefix?: string | null
			pageSize?: number
			startAfter?: string | null
		}) => Promise<StorageListResult>
		exportStorage: (payload: {
			pageSize?: number
			startAfter?: string | null
		}) => Promise<StorageExportResult>
		sqlQuery: (payload: {
			query: string
			params?: Array<unknown>
			writable?: boolean
		}) => Promise<StorageSqlResult>
	}
}

export function createStorageCodemodeTools(input: {
	env: Env
	userId: string
	storageId: string
	writable: boolean
}) {
	const runner = storageRunnerRpc({
		env: input.env,
		userId: input.userId,
		storageId: input.storageId,
	})
	return {
		storage_get: async (args: unknown) => {
			const key =
				typeof args === 'object' && args !== null && 'key' in args
					? String((args as { key: unknown }).key ?? '')
					: ''
			return await runner.getValue({ key })
		},
		storage_list: async (args: unknown) => {
			const payload =
				typeof args === 'object' && args !== null
					? (args as {
							prefix?: string | null
							pageSize?: number
							startAfter?: string | null
						})
					: {}
			return await runner.listValues({
				prefix:
					typeof payload.prefix === 'string' ? payload.prefix : undefined,
				pageSize:
					typeof payload.pageSize === 'number' ? payload.pageSize : undefined,
				startAfter:
					typeof payload.startAfter === 'string'
						? payload.startAfter
						: undefined,
			})
		},
		storage_sql: async (args: unknown) => {
			const payload =
				typeof args === 'object' && args !== null
					? (args as {
							query?: unknown
							params?: unknown
							writable?: unknown
						})
					: {}
			return await runner.sqlQuery({
				query: typeof payload.query === 'string' ? payload.query : '',
				params: Array.isArray(payload.params) ? payload.params : undefined,
				writable: input.writable
					? payload.writable === undefined
						? true
						: Boolean(payload.writable)
					: false,
			})
		},
		...(input.writable
			? {
					storage_set: async (args: unknown) => {
						const payload =
							typeof args === 'object' && args !== null
								? (args as { key?: unknown; value?: unknown })
								: {}
						return await runner.setValue({
							key: typeof payload.key === 'string' ? payload.key : '',
							value: payload.value,
						})
					},
					storage_delete: async (args: unknown) => {
						const key =
							typeof args === 'object' && args !== null && 'key' in args
								? String((args as { key: unknown }).key ?? '')
								: ''
						return await runner.deleteValue({ key })
					},
					storage_clear: async () => {
						return await runner.clearStorage()
					},
			  }
			: {}),
	}
}

export function createStorageHelperPrelude(input: {
	storageId: string
	writable: boolean
}) {
	return `
const storage = {
  id: ${JSON.stringify(input.storageId)},
  get: async (key) => (await codemode.storage_get({ key })).value,
  list: async (options = {}) => await codemode.storage_list(options),
  sql: async (query, params = []) =>
    await codemode.storage_sql({
      query,
      params,
      writable: ${input.writable ? 'true' : 'false'},
    }),
  ${input.writable ? `set: async (key, value) => await codemode.storage_set({ key, value }),
  delete: async (key) => await codemode.storage_delete({ key }),
  clear: async () => await codemode.storage_clear({}),` : ''}
};
	`.trim()
}
