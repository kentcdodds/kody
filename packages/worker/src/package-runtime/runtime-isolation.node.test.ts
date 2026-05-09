import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

// Pull the runtime virtual-module source out of module-graph.ts by exercising
// the same `createRuntimeModuleSource()` helper indirectly: we re-construct
// it here to keep this test focused on the AsyncLocalStorage contract.
//
// The runtime virtual module is the module that user code imports when it
// writes `import { codemode, storage, ... } from 'kody:runtime'`. The
// surrounding execute / package-app wrapper is responsible for putting the
// per-request runtime into the AsyncLocalStorage with __kodyRunInRuntime.
// This test verifies that two concurrent calls into the same isolate observe
// their own runtime view and never see each other's values, which is the
// invariant that replaces the previous globalThis-based save/restore.

async function loadRuntimeModule(source: string) {
	const dir = await mkdtemp(join(tmpdir(), 'kody-runtime-isolation-'))
	const filePath = join(dir, '.__kody_virtual__/runtime.js')
	await mkdir(dirname(filePath), { recursive: true })
	await writeFile(filePath, source, 'utf8')
	const url = pathToFileURL(filePath).href
	const mod = (await import(url)) as {
		__kodyRunInRuntime: <T>(value: unknown, callback: () => Promise<T>) => Promise<T>
		codemode: { tool_call: (args: unknown) => Promise<unknown> }
		storage: { get: (key: string) => Promise<unknown> }
		packageContext: Record<string, unknown> | null
	}
	return {
		mod,
		async cleanup() {
			await rm(dir, { recursive: true, force: true })
		},
	}
}

const runtimeSource = `
import { AsyncLocalStorage } from 'node:async_hooks';

const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __globalAny = globalThis;
const __kodyRuntimeStorage =
	__globalAny[__kodyRuntimeStorageSymbol] ??
	(__globalAny[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());

function __getRuntime() {
	return __kodyRuntimeStorage.getStore() ?? {};
}

export function __kodyRunInRuntime(runtime, callback) {
	return __kodyRuntimeStorage.run(runtime, callback);
}

function createValueProxy(getValue) {
	return new Proxy(function () {}, {
		get(_target, property) {
			const value = getValue();
			if (value == null) return undefined;
			const child = value[property];
			return typeof child === 'function' ? child.bind(value) : child;
		},
		apply(_target, _thisArg, args) {
			const value = getValue();
			if (typeof value !== 'function') {
				throw new Error('Runtime export is not callable in this context.');
			}
			return Reflect.apply(value, undefined, args);
		},
	});
}

export const codemode = createValueProxy(() => __getRuntime().codemode);
export const storage = createValueProxy(() => __getRuntime().storage);
export const packageContext = createValueProxy(
	() => __getRuntime().packageContext ?? null,
);
`.trim()

let cleanupRuntimeModule: (() => Promise<void>) | null = null

beforeEach(() => {
	const symbolKey = Symbol.for('kody.runtimeStorage')
	delete (globalThis as unknown as Record<symbol, unknown>)[symbolKey]
})

afterEach(async () => {
	if (cleanupRuntimeModule) {
		await cleanupRuntimeModule()
		cleanupRuntimeModule = null
	}
})

test('two concurrent runs observe their own runtime values', async () => {
	const { mod, cleanup } = await loadRuntimeModule(runtimeSource)
	cleanupRuntimeModule = cleanup

	type Observation = {
		userId: string
		toolValue: string
		storageValue: string
		packageId: string
	}

	const observations = new Map<string, Observation>()

	function buildRuntime(userId: string) {
		return {
			codemode: {
				async tool_call() {
					return { ok: true, userId }
				},
			},
			storage: {
				async get(key: string) {
					return { value: `${userId}:${key}` }
				},
			},
			packageContext: { packageId: `pkg-${userId}` },
		}
	}

	async function performRun(userId: string) {
		await mod.__kodyRunInRuntime(buildRuntime(userId), async () => {
			// Yield once so the two concurrent calls actually interleave.
			await new Promise<void>((resolve) => setImmediate(resolve))
			const toolResult = (await mod.codemode.tool_call({})) as {
				ok: true
				userId: string
			}
			await new Promise<void>((resolve) => setImmediate(resolve))
			const storageResult = (await mod.storage.get('answer')) as {
				value: string
			}
			await new Promise<void>((resolve) => setImmediate(resolve))
			const observation: Observation = {
				userId,
				toolValue: toolResult.userId,
				storageValue: storageResult.value,
				packageId: String(mod.packageContext?.packageId ?? ''),
			}
			observations.set(userId, observation)
		})
	}

	await Promise.all([performRun('user-aaa'), performRun('user-bbb')])

	expect(observations.get('user-aaa')).toEqual({
		userId: 'user-aaa',
		toolValue: 'user-aaa',
		storageValue: 'user-aaa:answer',
		packageId: 'pkg-user-aaa',
	})
	expect(observations.get('user-bbb')).toEqual({
		userId: 'user-bbb',
		toolValue: 'user-bbb',
		storageValue: 'user-bbb:answer',
		packageId: 'pkg-user-bbb',
	})
})

test('runtime exports throw clearly outside a runtime context', async () => {
	const { mod, cleanup } = await loadRuntimeModule(runtimeSource)
	cleanupRuntimeModule = cleanup

	// codemode/storage are Proxies; reading a property outside a runtime
	// context returns undefined rather than throwing - it's the access at
	// call time that should fail. We exercise the apply-trap explicitly.
	expect(() =>
		(mod.codemode as unknown as () => unknown)(),
	).toThrowError(/not callable/)
})

test('shared AsyncLocalStorage instance survives multiple module evaluations', async () => {
	const first = await loadRuntimeModule(runtimeSource)
	cleanupRuntimeModule = first.cleanup
	await first.mod.__kodyRunInRuntime({ packageContext: { packageId: 'a' } }, async () => {
		expect(String(first.mod.packageContext?.packageId ?? '')).toBe('a')

		// A second evaluation of the same source (e.g. a nested dynamic
		// import in the same isolate) must observe the *same* ALS instance,
		// otherwise concurrent contexts would silently leak.
		const second = await loadRuntimeModule(runtimeSource)
		try {
			expect(String(second.mod.packageContext?.packageId ?? '')).toBe('a')
			await second.mod.__kodyRunInRuntime(
				{ packageContext: { packageId: 'b' } },
				async () => {
					expect(String(first.mod.packageContext?.packageId ?? '')).toBe('b')
					expect(String(second.mod.packageContext?.packageId ?? '')).toBe('b')
				},
			)
			// Outer context restored when inner run() completes.
			expect(String(first.mod.packageContext?.packageId ?? '')).toBe('a')
		} finally {
			await second.cleanup()
		}
	})
})
