import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, test } from 'vitest'
import { createRuntimeModuleSource } from './module-graph.ts'

// The kody:runtime virtual module captures its named exports statically
// when it evaluates inside the surrounding AsyncLocalStorage context. The
// surrounding wrapper (kody executor / package-app worker) loads the
// bundle fresh per request, so each request gets a fresh evaluation with
// the per-request runtime values.
//
// These tests stand up the same shape against the local filesystem to verify
// that two concurrent calls each capture their own runtime view, optional
// runtime exports stay falsy so user code's `if (email) { ... }` guards keep
// working, and a preloaded runtime still late-binds the always-present kody
// namespace inside the execution context.

const runtimeSource = createRuntimeModuleSource()

type RuntimeModule = {
	__kodyRunInRuntime: <T>(
		value: unknown,
		callback: () => Promise<T>,
	) => Promise<T>
	kody: { tool_call: (args: unknown) => Promise<unknown> } | undefined
	codemode?: unknown
	capabilities?: unknown
	storage: { get: (key: string) => Promise<unknown> } | undefined
	email: unknown
	packageContext: Record<string, unknown> | null
	default: {
		kody?: { tool_call: (args: unknown) => Promise<unknown> }
		codemode?: unknown
		capabilities?: unknown
	}
}

function resetRuntimeStorageSymbol() {
	const symbolKey = Symbol.for('kody.runtimeStorage')
	delete (globalThis as unknown as Record<symbol, unknown>)[symbolKey]
}

async function writeRuntimeFile(cleanupCallbacks: Array<() => Promise<void>>) {
	const dir = await mkdtemp(join(tmpdir(), 'kody-runtime-isolation-'))
	const filePath = join(dir, '.__kody_virtual__/runtime.js')
	await mkdir(dirname(filePath), { recursive: true })
	await writeFile(filePath, runtimeSource, 'utf8')
	cleanupCallbacks.push(() => rm(dir, { recursive: true, force: true }))
	return pathToFileURL(filePath).href
}

async function withRuntimeIsolationCleanup<T>(
	callback: (helpers: {
		writeRuntimeFile: () => Promise<string>
	}) => Promise<T>,
) {
	resetRuntimeStorageSymbol()
	const cleanupCallbacks: Array<() => Promise<void>> = []
	try {
		return await callback({
			writeRuntimeFile: () => writeRuntimeFile(cleanupCallbacks),
		})
	} finally {
		while (cleanupCallbacks.length > 0) {
			const cleanup = cleanupCallbacks.pop()
			if (cleanup) await cleanup()
		}
	}
}

test('two concurrent runs observe their own runtime values', async () => {
	await withRuntimeIsolationCleanup(async ({ writeRuntimeFile }) => {
		const sharedStorage = new AsyncLocalStorage<unknown>()
		;(globalThis as unknown as Record<symbol, unknown>)[
			Symbol.for('kody.runtimeStorage')
		] = sharedStorage

		type Observation = {
			userId: string
			toolValue: string
			storageValue: string
			packageId: string
		}

		const observations = new Map<string, Observation>()

		function buildRuntime(userId: string) {
			return {
				kody: {
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
			// Each "request" has its own fresh runtime module, mirroring the
			// production behaviour where DynamicWorkerExecutor / APP_LOADER.load()
			// produce a fresh isolate per request. The module evaluates inside
			// the AsyncLocalStorage context and captures the per-request runtime.
			await sharedStorage.run(buildRuntime(userId), async () => {
				const url = await writeRuntimeFile()
				await new Promise<void>((resolve) => setImmediate(resolve))
				const mod = (await import(url)) as RuntimeModule
				await new Promise<void>((resolve) => setImmediate(resolve))
				const tool = mod.kody
				if (!tool) throw new Error('kody missing')
				const toolResult = (await tool.tool_call({})) as {
					ok: true
					userId: string
				}
				const store = mod.storage
				if (!store) throw new Error('storage missing')
				const storageResult = (await store.get('answer')) as { value: string }
				observations.set(userId, {
					userId,
					toolValue: toolResult.userId,
					storageValue: storageResult.value,
					packageId: String(mod.packageContext?.packageId ?? ''),
				})
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
})

test('optional runtime exports stay falsy when the wrapper omits them', async () => {
	await withRuntimeIsolationCleanup(async ({ writeRuntimeFile }) => {
		const sharedStorage = new AsyncLocalStorage<unknown>()
		;(globalThis as unknown as Record<symbol, unknown>)[
			Symbol.for('kody.runtimeStorage')
		] = sharedStorage

		let captured: RuntimeModule | null = null
		await sharedStorage.run(
			// Intentionally omit `email`, `storage`, `kody` from the runtime
			// payload to mirror an execute call that did not bind any of those
			// runtime helpers.
			{ packageContext: { packageId: 'pkg-1' } },
			async () => {
				const url = await writeRuntimeFile()
				captured = (await import(url)) as RuntimeModule
			},
		)

		const mod = captured as unknown as RuntimeModule
		// Each missing export must be falsy so user code that does
		// `if (email) {...}` continues to skip the branch.
		expect(mod.email).toBeNull()
		expect(mod.kody).toBeUndefined()
		expect(mod.codemode).toBeUndefined()
		expect(mod.capabilities).toBeUndefined()
		expect(mod.storage).toBeUndefined()
		expect(Boolean(mod.email)).toBe(false)
		expect(Boolean(mod.kody)).toBe(false)
		expect(Boolean(mod.codemode)).toBe(false)
		expect(Boolean(mod.capabilities)).toBe(false)
		expect(Boolean(mod.storage)).toBe(false)
		// Provided exports survive.
		expect(mod.packageContext).toEqual({ packageId: 'pkg-1' })
	})
})

test('preloaded kody exports resolve from the active runtime store', async () => {
	await withRuntimeIsolationCleanup(async ({ writeRuntimeFile }) => {
		const sharedStorage = new AsyncLocalStorage<unknown>()
		;(globalThis as unknown as Record<symbol, unknown>)[
			Symbol.for('kody.runtimeStorage')
		] = sharedStorage
		const url = await writeRuntimeFile()
		const mod = (await import(url)) as RuntimeModule
		expect(mod.codemode).toBeUndefined()
		expect(mod.capabilities).toBeUndefined()
		expect(mod.default.codemode).toBeUndefined()
		expect(mod.default.capabilities).toBeUndefined()

		const namedExportResult = await sharedStorage.run(
			{
				kody: {
					async tool_call(args: unknown) {
						return { ok: true, args }
					},
				},
			},
			async () => {
				const tool = mod.kody
				if (!tool) throw new Error('kody missing')
				return await tool.tool_call({ value: 'active-store' })
			},
		)

		expect(namedExportResult).toEqual({
			ok: true,
			args: { value: 'active-store' },
		})

		const defaultExportResult = await sharedStorage.run(
			{
				kody: {
					async tool_call(args: unknown) {
						return { ok: true, args }
					},
				},
			},
			async () => {
				const tool = mod.default.kody
				if (!tool) throw new Error('default kody missing')
				return await tool.tool_call({ value: 'default-active-store' })
			},
		)

		expect(defaultExportResult).toEqual({
			ok: true,
			args: { value: 'default-active-store' },
		})
	})
})
