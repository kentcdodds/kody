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
 * Unique worker days are the billed and capped unit, so the same inputs must
 * always mint the same id. A module value that cannot be hashed (a function,
 * symbol, or compiled `WebAssembly.Module`) throws instead of minting a
 * one-off id that would bill and count as a new worker on every call.
 */
export async function createStableDynamicWorkerId(input: {
	userId: string | null
	storageContext: StorageContext | null
	workerOptions: DynamicWorkerIdOptions
	cacheKeyVersion?: number
}) {
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

function canonicalJsonStringify(value: unknown) {
	return JSON.stringify(canonicalizeForHash(value, '$'))
}

/**
 * Every non-primitive becomes a tagged array (`['object', ...]`,
 * `['bytes', ...]`), so user JSON can never spell another value's encoding.
 * Only plain objects are walked: anything else (a compiled
 * `WebAssembly.Module`, Map, class instance) exposes no hashable contents
 * and would collide with every other value of its kind.
 */
function canonicalizeForHash(value: unknown, path: string): unknown {
	if (value === undefined) return ['undefined']
	if (value === null) return null
	if (typeof value === 'bigint') return ['bigint', String(value)]
	if (typeof value === 'function' || typeof value === 'symbol') {
		throw unhashableModuleValue(path, `a ${typeof value}`)
	}
	if (typeof value !== 'object') return value
	if (value instanceof ArrayBuffer) {
		return ['bytes', bytesToBase64Url(new Uint8Array(value))]
	}
	if (ArrayBuffer.isView(value)) {
		return [
			'bytes',
			bytesToBase64Url(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		]
	}
	if (Array.isArray(value)) {
		return [
			'array',
			...value.map((entry, index) =>
				canonicalizeForHash(entry, `${path}[${index}]`),
			),
		]
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw unhashableModuleValue(
			path,
			`a ${value.constructor?.name ?? 'non-plain'} object`,
		)
	}
	const record = value as Record<string, unknown>
	return [
		'object',
		...Object.keys(record)
			.sort((left, right) => left.localeCompare(right))
			.map((key) => [key, canonicalizeForHash(record[key], `${path}.${key}`)]),
	]
}

function unhashableModuleValue(path: string, kind: string) {
	return new TypeError(
		`Dynamic Worker id input ${path} is ${kind}; worker modules must be strings, byte buffers, or JSON values.`,
	)
}
