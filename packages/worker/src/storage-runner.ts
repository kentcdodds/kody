import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageSqlWriteBytes,
	readUserD1StorageBytes,
} from '#worker/entitlements/service.ts'
import {
	registerStorageBucket,
	storageBucketKindFromStorageId,
} from '#worker/storage-buckets/service.ts'
import { storageRunnerDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'

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

type StorageEstimateResult = {
	estimatedBytes: number
}

/**
 * Paged replace protocol for StorageRunner restore:
 * - `replacePage: 'first'` clears the entire bucket, then writes entries
 *   (JSON-parsed from `valueJson`).
 * - `replacePage: 'continue'` upserts additional entries without clearing.
 * - Callers must send pages in order for a single replace session; sending
 *   `'first'` again restarts the replace (idempotent retry of page 1).
 * - Empty `'first'` pages are valid and leave the bucket empty.
 */
export async function applyImportStoragePage(
	storage: {
		deleteAll: () => Promise<void> | void
		put: (key: string, value: unknown) => Promise<void> | void
	},
	input: {
		mode: 'replace'
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; valueJson: string }>
	},
): Promise<{ ok: true; written: number; cleared: boolean }> {
	switch (input.mode) {
		case 'replace':
			break
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unsupported importStorage mode: ${String(exhaustive)}`)
		}
	}
	let cleared = false
	switch (input.replacePage) {
		case 'first': {
			await storage.deleteAll()
			cleared = true
			break
		}
		case 'continue':
			break
		default: {
			const exhaustive: never = input.replacePage
			throw new Error(
				`Unsupported importStorage replacePage: ${String(exhaustive)}`,
			)
		}
	}
	let written = 0
	for (const entry of input.entries) {
		const key = normalizeStorageKey(entry.key)
		let value: unknown
		try {
			value = JSON.parse(entry.valueJson) as unknown
		} catch {
			throw new Error(`importStorage received invalid valueJson for key ${key}`)
		}
		await storage.put(key, value)
		written += 1
	}
	return { ok: true, written, cleared }
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

function hasSqlContentAfterSemicolon(query: string, startIndex: number) {
	let inLineComment = false
	let inBlockComment = false

	for (let index = startIndex; index < query.length; index += 1) {
		const current = query.charAt(index)
		const next = query.charAt(index + 1)

		if (inLineComment) {
			if (current === '\n') {
				inLineComment = false
			}
			continue
		}

		if (inBlockComment) {
			if (current === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (current === '-' && next === '-') {
			inLineComment = true
			index += 1
			continue
		}

		if (current === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		if (!/\s/.test(current)) {
			return true
		}
	}

	return false
}

function hasMultipleSqlStatements(query: string) {
	let inSingleQuote = false
	let inDoubleQuote = false
	let inBacktickQuote = false
	let inBracketQuote = false
	let inLineComment = false
	let inBlockComment = false

	for (let index = 0; index < query.length; index += 1) {
		const current = query.charAt(index)
		const next = query.charAt(index + 1)

		if (inLineComment) {
			if (current === '\n') {
				inLineComment = false
			}
			continue
		}

		if (inBlockComment) {
			if (current === '*' && next === '/') {
				inBlockComment = false
				index += 1
			}
			continue
		}

		if (inSingleQuote) {
			if (current === "'" && next === "'") {
				index += 1
				continue
			}
			if (current === "'") {
				inSingleQuote = false
			}
			continue
		}

		if (inDoubleQuote) {
			if (current === '"' && next === '"') {
				index += 1
				continue
			}
			if (current === '"') {
				inDoubleQuote = false
			}
			continue
		}

		if (inBacktickQuote) {
			if (current === '`') {
				inBacktickQuote = false
			}
			continue
		}

		if (inBracketQuote) {
			if (current === ']') {
				inBracketQuote = false
			}
			continue
		}

		if (current === '-' && next === '-') {
			inLineComment = true
			index += 1
			continue
		}

		if (current === '/' && next === '*') {
			inBlockComment = true
			index += 1
			continue
		}

		if (current === "'") {
			inSingleQuote = true
			continue
		}

		if (current === '"') {
			inDoubleQuote = true
			continue
		}

		if (current === '`') {
			inBacktickQuote = true
			continue
		}

		if (current === '[') {
			inBracketQuote = true
			continue
		}

		if (current === ';' && hasSqlContentAfterSemicolon(query, index + 1)) {
			return true
		}
	}

	return false
}

function assertSqlAllowed(query: string, writable: boolean | undefined) {
	const trimmed = query.trim()
	if (!trimmed) {
		throw new Error('storage.sql requires a non-empty query.')
	}
	if (writable) return trimmed
	if (hasMultipleSqlStatements(trimmed)) {
		throw new Error(
			'Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement. Pass writable: true to allow multi-statement or mutating queries.',
		)
	}
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
	if (allowedReadOnlyPrefixes.some((prefix) => normalized.startsWith(prefix))) {
		return trimmed
	}
	throw new Error(
		'Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement. Pass writable: true to allow multi-statement or mutating queries.',
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

	async setValue(input: {
		key: string
		value: unknown
	}): Promise<StorageSetResult> {
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

	async getEstimatedBytes(): Promise<StorageEstimateResult> {
		return { estimatedBytes: this.ctx.storage.sql.databaseSize }
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

	/**
	 * Paged restore counterpart of {@link exportStorage}.
	 * See {@link applyImportStoragePage} for the replace protocol.
	 */
	async importStorage(input: {
		mode: 'replace'
		replacePage: 'first' | 'continue'
		entries: Array<{ key: string; valueJson: string }>
	}): Promise<{
		ok: true
		written: number
		cleared: boolean
	}> {
		return await applyImportStoragePage(this.ctx.storage, input)
	}

	async sqlQuery(input: {
		query: string
		params?: Array<unknown>
		writable?: boolean
	}): Promise<StorageSqlResult> {
		const query = assertSqlAllowed(input.query, input.writable)
		const params = normalizeSqlParams(input.params)
		const cursor = this.ctx.storage.sql.exec<Record<string, StorageSqlValue>>(
			query,
			...params,
		)
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
	const runner = input.env.STORAGE_RUNNER.get(
		input.env.STORAGE_RUNNER.idFromName(
			storageRunnerDurableObjectName(input.userId, input.storageId),
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
		getEstimatedBytes: () => Promise<StorageEstimateResult>
		listValues: (payload: {
			prefix?: string | null
			pageSize?: number
			startAfter?: string | null
		}) => Promise<StorageListResult>
		exportStorage: (payload: {
			pageSize?: number
			startAfter?: string | null
		}) => Promise<StorageExportResult>
		importStorage: (payload: {
			mode: 'replace'
			replacePage: 'first' | 'continue'
			entries: Array<{ key: string; valueJson: string }>
		}) => Promise<{ ok: true; written: number; cleared: boolean }>
		sqlQuery: (payload: {
			query: string
			params?: Array<unknown>
			writable?: boolean
		}) => Promise<StorageSqlResult>
	}

	// Registration must never run on a path that executes after the owning
	// user's D1 rows are removed. Account deletion clears StorageRunner DOs
	// via clearStorage, then deletes user_storage_buckets; registering on
	// clear would fire-and-forget an upsert that can recreate rows for a
	// deleted user. Clearing also is not evidence of use — prior writes
	// already registered the bucket.
	const registerOwnedBucket = () => {
		registerStorageBucket({
			env: input.env,
			userId: input.userId,
			storageId: input.storageId,
			kind: storageBucketKindFromStorageId(input.storageId),
		})
	}

	return {
		getValue: (payload: { key: string }) => runner.getValue(payload),
		setValue: (payload: { key: string; value: unknown }) => {
			registerOwnedBucket()
			return runner.setValue(payload)
		},
		deleteValue: (payload: { key: string }) => {
			registerOwnedBucket()
			return runner.deleteValue(payload)
		},
		clearStorage: () => runner.clearStorage(),
		getEstimatedBytes: () => runner.getEstimatedBytes(),
		listValues: (payload: {
			prefix?: string | null
			pageSize?: number
			startAfter?: string | null
		}) => runner.listValues(payload),
		exportStorage: (payload: {
			pageSize?: number
			startAfter?: string | null
		}) => runner.exportStorage(payload),
		importStorage: (payload: {
			mode: 'replace'
			replacePage: 'first' | 'continue'
			entries: Array<{ key: string; valueJson: string }>
		}) => {
			registerOwnedBucket()
			return runner.importStorage(payload)
		},
		sqlQuery: (payload: {
			query: string
			params?: Array<unknown>
			writable?: boolean
		}) => {
			if (payload.writable) {
				registerOwnedBucket()
			}
			return runner.sqlQuery(payload)
		},
	}
}

export async function assertStorageRunnerWriteWithinEntitlement(input: {
	env: Env
	userId: string
	email: string | null | undefined
	storageId: string
	requested?: number
}) {
	const runner = storageRunnerRpc({
		env: input.env,
		userId: input.userId,
		storageId: input.storageId,
	})
	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		userId: input.userId,
		email: input.email,
		requested: input.requested,
		getCurrent: async () =>
			(await readUserD1StorageBytes({
				db: input.env.APP_DB,
				userId: input.userId,
			})) + (await runner.getEstimatedBytes()).estimatedBytes,
	})
}

export function createStorageKodyTools(input: {
	env: Env
	userId: string
	email?: string | null
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
				prefix: typeof payload.prefix === 'string' ? payload.prefix : undefined,
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
			const writable = input.writable
				? payload.writable === undefined
					? true
					: Boolean(payload.writable)
				: false
			const query = typeof payload.query === 'string' ? payload.query : ''
			const params = Array.isArray(payload.params) ? payload.params : undefined
			if (writable) {
				await assertStorageRunnerWriteWithinEntitlement({
					env: input.env,
					userId: input.userId,
					email: input.email,
					storageId: input.storageId,
					requested: estimateEntitlementStorageSqlWriteBytes({
						query,
						params,
					}),
				})
			}
			return await runner.sqlQuery({
				query,
				params,
				writable,
			})
		},
		...(input.writable
			? {
					storage_set: async (args: unknown) => {
						const payload =
							typeof args === 'object' && args !== null
								? (args as { key?: unknown; value?: unknown })
								: {}
						const key = typeof payload.key === 'string' ? payload.key : ''
						const existing = await runner.getValue({ key })
						await assertStorageRunnerWriteWithinEntitlement({
							env: input.env,
							userId: input.userId,
							email: input.email,
							storageId: input.storageId,
							requested: estimateEntitlementStorageEntryByteDelta({
								next: {
									key,
									value: payload.value,
								},
								existing:
									existing.value === null
										? null
										: {
												key,
												value: existing.value,
											},
							}),
						})
						return await runner.setValue({
							key,
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

/**
 * Durable storage id of a saved package's own bucket. Shared by package
 * invocations (ambient `storage` in a package's own runtime) and
 * `packageStorage()` so both reach the same bucket for one package.
 */
export function buildPackageStorageId(packageId: string) {
	return `package:${encodeURIComponent(packageId)}`
}

export function createPackageStorageAccessDeniedMessage(packageId: string) {
	return (
		`packageStorage() cannot access the storage of package "${packageId}" from this execution context. ` +
		'Package storage access is granted only from bundler-recorded provenance: the running package itself and ' +
		'the saved packages this bundle statically imported (kody:@scope/package/export). To work with another ' +
		"package's data, call one of its exports via packages.invokeChecked({ kodyId, exportName, params })."
	)
}

/**
 * `kody.package_storage_*` tools backing the `packageStorage()` runtime
 * helper. Unlike `createStorageKodyTools` (bound to one storage id for a
 * whole run) these take a `packageId` argument per call, because one bundle
 * can contain modules from several saved packages that each own a bucket.
 *
 * Security boundary: the sandbox-supplied `packageId` is honored only when
 * it is in `grantedPackageIds`, which the host computes from
 * bundler-controlled provenance metadata (the run's own package context and
 * the bundle's recorded static/dynamic package dependencies). Hand-written
 * module source claiming an arbitrary package id is rejected here even if it
 * forges a stamped-looking call, so a malicious package cannot reach other
 * installed packages' buckets. Cross-user access is structurally impossible:
 * `storageRunnerDurableObjectName` keys the durable object on this run's user id.
 */
export function createPackageStorageKodyTools(input: {
	env: Env
	userId: string
	email?: string | null
	grantedPackageIds: ReadonlySet<string>
}) {
	const createWritableStorageTools = (packageId: string) => {
		const {
			storage_get,
			storage_list,
			storage_sql,
			storage_set,
			storage_delete,
			storage_clear,
		} = createStorageKodyTools({
			env: input.env,
			userId: input.userId,
			email: input.email,
			storageId: buildPackageStorageId(packageId),
			writable: true,
		})
		if (!storage_set || !storage_delete || !storage_clear) {
			// createStorageKodyTools only omits these when writable is false.
			throw new Error('Writable package storage tools are missing writes.')
		}
		return {
			storage_get,
			storage_list,
			storage_sql,
			storage_set,
			storage_delete,
			storage_clear,
		}
	}
	const toolsByPackageId = new Map<
		string,
		ReturnType<typeof createWritableStorageTools>
	>()
	const resolveTools = (args: unknown) => {
		const packageId =
			typeof args === 'object' && args !== null && 'packageId' in args
				? String((args as { packageId: unknown }).packageId ?? '').trim()
				: ''
		if (!packageId) {
			throw new Error('packageStorage requires a non-empty package id.')
		}
		if (!input.grantedPackageIds.has(packageId)) {
			throw new Error(createPackageStorageAccessDeniedMessage(packageId))
		}
		let tools = toolsByPackageId.get(packageId)
		if (!tools) {
			tools = createWritableStorageTools(packageId)
			toolsByPackageId.set(packageId, tools)
		}
		return tools
	}
	return {
		package_storage_get: async (args: unknown) =>
			await resolveTools(args).storage_get(args),
		package_storage_list: async (args: unknown) =>
			await resolveTools(args).storage_list(args),
		package_storage_sql: async (args: unknown) =>
			await resolveTools(args).storage_sql(args),
		package_storage_set: async (args: unknown) =>
			await resolveTools(args).storage_set(args),
		package_storage_delete: async (args: unknown) =>
			await resolveTools(args).storage_delete(args),
		package_storage_clear: async (args: unknown) =>
			await resolveTools(args).storage_clear(),
	}
}

/**
 * Sandbox-side factory behind the `packageStorage()` runtime export. The
 * virtual `kody:runtime` module resolves the declaring package id (from the
 * bundle-time stamp or the run's own package context) and calls this factory
 * through the AsyncLocalStorage runtime store; the host still validates the
 * id against the run's provenance grants in `createPackageStorageKodyTools`.
 */
export function createPackageStorageHelperPrelude() {
	// The interface mirrors the ambient `storage` helper but always writable;
	// `id` mirrors buildPackageStorageId above (covered by a unit test).
	return `
const __kodyPackageStorage = (packageId) => ({
  id: 'package:' + encodeURIComponent(packageId),
  get: async (key) => (await kody.package_storage_get({ packageId, key })).value,
  list: async (options = {}) => await kody.package_storage_list({ ...options, packageId }),
  sql: async (query, params = []) =>
    await kody.package_storage_sql({
      packageId,
      query,
      params,
      writable: true,
    }),
  set: async (key, value) => await kody.package_storage_set({ packageId, key, value }),
  delete: async (key) => await kody.package_storage_delete({ packageId, key }),
  clear: async () => await kody.package_storage_clear({ packageId }),
});
	`.trim()
}

export function createStorageHelperPrelude(input: {
	storageId: string
	writable: boolean
}) {
	return `
const storage = {
  id: ${JSON.stringify(input.storageId)},
  get: async (key) => (await kody.storage_get({ key })).value,
  list: async (options = {}) => await kody.storage_list(options),
  sql: async (query, params = []) =>
    await kody.storage_sql({
      query,
      params,
      writable: ${input.writable ? 'true' : 'false'},
    }),
  ${
		input.writable
			? `set: async (key, value) => await kody.storage_set({ key, value }),
  delete: async (key) => await kody.storage_delete({ key }),
  clear: async () => await kody.storage_clear({}),`
			: ''
	}
};
	`.trim()
}
