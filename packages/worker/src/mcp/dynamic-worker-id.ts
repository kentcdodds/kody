import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

export const dynamicWorkerIdPrefix = 'kody-'

/**
 * Sandbox-contract / cache-key version. Bump only when the executor harness
 * or LOADER identity contract changes — not on every parent commit.
 */
export const dynamicWorkerCacheKeyVersion = 7

export type DynamicWorkerIdOptions = {
	compatibilityDate: string
	compatibilityFlags: Array<string>
	mainModule: string
	modules: WorkerLoaderModules
}

/**
 * Stable LOADER id for a Dynamic Worker isolate.
 *
 * Identity is the module graph (agent code plus generated harness), compat
 * knobs, an explicit contract version, and the acting-user facets bound on
 * `globalOutbound` (`userId`, `storageContext`). `LOADER.get` reuses the
 * first factory's WorkerCode for a given id, including that gateway stub, so
 * those facets stay in the key. Deploy SHA, email, execute `params`,
 * `packageContext`, live MCP connect/tool metadata, and other request-only
 * fields do not — those arrive on `evaluate` RPC.
 *
 * UUID fallback when modules are not deterministically hashable.
 */
export async function createStableDynamicWorkerId(input: {
	userId: string | null
	storageContext: StorageContext | null
	workerOptions: DynamicWorkerIdOptions
	cacheKeyVersion?: number
}) {
	if (!areWorkerModulesDeterministicallyHashable(input.workerOptions.modules)) {
		return `${dynamicWorkerIdPrefix}${crypto.randomUUID()}`
	}
	const hash = await sha256Base64Url(
		canonicalJsonStringify({
			version: input.cacheKeyVersion ?? dynamicWorkerCacheKeyVersion,
			binding: 'LOADER',
			userId: input.userId,
			storageContext: input.storageContext,
			compatibilityDate: input.workerOptions.compatibilityDate,
			compatibilityFlags: input.workerOptions.compatibilityFlags,
			mainModule: input.workerOptions.mainModule,
			modules: input.workerOptions.modules,
		}),
	)
	return `${dynamicWorkerIdPrefix}${hash.slice(0, 43)}`
}

function areWorkerModulesDeterministicallyHashable(
	modules: WorkerLoaderModules,
) {
	for (const moduleValue of Object.values(modules)) {
		if (!isDeterministicallyHashableWorkerModule(moduleValue)) {
			return false
		}
	}
	return true
}

function isDeterministicallyHashableWorkerModule(
	moduleValue: WorkerLoaderModules[string],
) {
	if (typeof moduleValue === 'string') return true
	if (moduleValue === null || typeof moduleValue !== 'object') return false
	const record = moduleValue as Record<string, unknown>
	for (const key of ['js', 'cjs', 'text'] as const) {
		const value = record[key]
		if (value !== undefined && typeof value !== 'string') return false
	}
	if (record.data !== undefined && !(record.data instanceof ArrayBuffer)) {
		return false
	}
	if (
		record.json !== undefined &&
		!isDeterministicallyHashableValue(record.json)
	) {
		return false
	}
	for (const [key, value] of Object.entries(record)) {
		if (
			key !== 'js' &&
			key !== 'cjs' &&
			key !== 'text' &&
			key !== 'data' &&
			key !== 'json'
		) {
			return false
		}
		if (key === 'data' || key === 'json') continue
		if (value !== undefined && typeof value !== 'string') return false
	}
	return true
}

function isDeterministicallyHashableValue(value: unknown): boolean {
	if (value === null) return true
	const valueType = typeof value
	if (
		valueType === 'string' ||
		valueType === 'number' ||
		valueType === 'boolean'
	) {
		return true
	}
	if (valueType === 'bigint' || valueType === 'undefined') return true
	if (valueType === 'function' || valueType === 'symbol') return false
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
	if (Array.isArray(value)) {
		return value.every((entry) => isDeterministicallyHashableValue(entry))
	}
	if (valueType === 'object') {
		const record = value as Record<string, unknown>
		return Object.values(record).every((entry) =>
			isDeterministicallyHashableValue(entry),
		)
	}
	return false
}

function canonicalJsonStringify(value: unknown) {
	return JSON.stringify(canonicalizeForHash(value))
}

function canonicalizeForHash(value: unknown): unknown {
	if (value === undefined) return { __kodyType: 'undefined' }
	if (value === null) return null
	if (typeof value === 'bigint')
		return { __kodyType: 'bigint', value: String(value) }
	if (typeof value !== 'object') return value
	if (value instanceof ArrayBuffer) {
		return {
			__kodyType: 'arrayBuffer',
			value: bytesToBase64Url(new Uint8Array(value)),
		}
	}
	if (ArrayBuffer.isView(value)) {
		return {
			__kodyType: 'arrayBuffer',
			value: bytesToBase64Url(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		}
	}
	if (Array.isArray(value))
		return value.map((entry) => canonicalizeForHash(entry))
	const record = value as Record<string, unknown>
	return Object.fromEntries(
		Object.keys(record)
			.sort((left, right) => left.localeCompare(right))
			.map((key) => [key, canonicalizeForHash(record[key])]),
	)
}
