import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, test } from 'vitest'
import { createKodyRemoteProxy } from '#mcp/executor.ts'
import {
	createRuntimeModuleReexportSource,
	createRuntimeModuleSource,
} from './module-graph.ts'

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

type McpServers = Record<
	string,
	Record<string, (args: unknown) => Promise<unknown>>
>

type RuntimeModule = {
	__kodyRunInRuntime: <T>(
		value: unknown,
		callback: () => Promise<T>,
	) => Promise<T>
	__kodyMeterStaticPackageExport: <T>(packageId: string, exportValue: T) => T
	__kodyGetSecretAuthority: () => string | null
	kody:
		| { tool_call: (args: unknown) => Promise<unknown>; mcp: McpServers }
		| undefined
	codemode?: unknown
	capabilities?: unknown
	email: { getMessage: (id: string) => Promise<unknown> } | null
	packageContext: Record<string, unknown> | null
	packageSecrets: { get: (alias: string) => Promise<string> }
	default: {
		kody?: { tool_call: (args: unknown) => Promise<unknown> }
		codemode?: unknown
		capabilities?: unknown
	}
}

type GlobalSymbols = Record<symbol, unknown>

async function writeTempFiles(
	cleanupCallbacks: Array<() => Promise<void>>,
	files: Record<string, string>,
) {
	const dir = await mkdtemp(join(tmpdir(), 'kody-runtime-isolation-'))
	cleanupCallbacks.push(() => rm(dir, { recursive: true, force: true }))
	const urls: Record<string, string> = {}
	for (const [relativePath, source] of Object.entries(files)) {
		const filePath = join(dir, relativePath)
		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, source, 'utf8')
		urls[relativePath] = pathToFileURL(filePath).href
	}
	return urls
}

async function withRuntimeIsolationCleanup(
	callback: (helpers: {
		writeRuntimeFile: () => Promise<string>
		writeTempFiles: (
			files: Record<string, string>,
		) => Promise<Record<string, string>>
		installSharedStorage: () => AsyncLocalStorage<unknown>
		loadPreloadedRuntime: () => Promise<{
			storage: AsyncLocalStorage<unknown>
			mod: RuntimeModule
			kodyMcp: () => McpServers
		}>
	}) => Promise<void>,
) {
	const globals = globalThis as unknown as GlobalSymbols
	delete globals[Symbol.for('kody.runtimeStorage')]
	delete globals[Symbol.for('kody.secretAuthorityStorage')]
	const cleanupCallbacks: Array<() => Promise<void>> = []
	const writeRuntimeFile = async () =>
		(
			await writeTempFiles(cleanupCallbacks, {
				'.__kody_virtual__/runtime.js': runtimeSource,
			})
		)['.__kody_virtual__/runtime.js'] ?? ''
	const installSharedStorage = () => {
		const storage = new AsyncLocalStorage<unknown>()
		globals[Symbol.for('kody.runtimeStorage')] = storage
		return storage
	}
	try {
		await callback({
			writeRuntimeFile,
			writeTempFiles: (files) => writeTempFiles(cleanupCallbacks, files),
			installSharedStorage,
			loadPreloadedRuntime: async () => {
				const storage = installSharedStorage()
				const mod = (await import(await writeRuntimeFile())) as RuntimeModule
				return { storage, mod, kodyMcp: () => mod.kody?.mcp ?? {} }
			},
		})
	} finally {
		while (cleanupCallbacks.length > 0) {
			await cleanupCallbacks.pop()?.()
		}
	}
}

test('two concurrent runs observe their own runtime values', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeRuntimeFile, installSharedStorage }) => {
			const sharedStorage = installSharedStorage()
			const observations = new Map<string, Record<string, string>>()

			async function performRun(userId: string) {
				// Each "request" has its own fresh runtime module, mirroring the
				// production behaviour where DynamicWorkerExecutor / APP_LOADER.load()
				// produce a fresh isolate per request. The module evaluates inside
				// the AsyncLocalStorage context and captures the per-request runtime.
				const runtime = {
					kody: {
						async tool_call() {
							return { ok: true, userId }
						},
					},
					email: {
						async getMessage(id: string) {
							return { id: `${userId}:${id}` }
						},
					},
					packageContext: { packageId: `pkg-${userId}` },
				}
				await sharedStorage.run(runtime, async () => {
					const url = await writeRuntimeFile()
					await new Promise<void>((resolve) => setImmediate(resolve))
					const mod = (await import(url)) as RuntimeModule
					await new Promise<void>((resolve) => setImmediate(resolve))
					if (!mod.kody) throw new Error('kody missing')
					if (!mod.email) throw new Error('email missing')
					const toolResult = (await mod.kody.tool_call({})) as {
						userId: string
					}
					const emailResult = (await mod.email.getMessage('m-1')) as {
						id: string
					}
					observations.set(userId, {
						userId,
						toolValue: toolResult.userId,
						emailValue: emailResult.id,
						packageId: String(mod.packageContext?.packageId ?? ''),
					})
				})
			}

			await Promise.all([performRun('user-aaa'), performRun('user-bbb')])

			for (const userId of ['user-aaa', 'user-bbb']) {
				expect(observations.get(userId)).toEqual({
					userId,
					toolValue: userId,
					emailValue: `${userId}:m-1`,
					packageId: `pkg-${userId}`,
				})
			}
		},
	)
})

test('optional runtime exports stay falsy when the wrapper omits them', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeRuntimeFile, installSharedStorage }) => {
			const { mod, observedPackageContext } = await installSharedStorage().run(
				// Intentionally omit `email`, `kody` from the runtime payload to
				// mirror an execute call that did not bind any of those helpers.
				{ packageContext: { packageId: 'pkg-1' } },
				async () => {
					const mod = (await import(await writeRuntimeFile())) as RuntimeModule
					return { mod, observedPackageContext: { ...mod.packageContext } }
				},
			)

			// Each missing export must be falsy so user code that does
			// `if (email) {...}` continues to skip the branch.
			expect(mod.email).toBeNull()
			expect(mod.kody).toBeUndefined()
			expect(mod.codemode).toBeUndefined()
			expect(mod.capabilities).toBeUndefined()
			// packageContext is late-bound; read it inside the store run.
			expect(observedPackageContext).toEqual({ packageId: 'pkg-1' })
		},
	)
})

test('preloaded kody exports resolve from the active runtime store', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, mod } = await loadPreloadedRuntime()
		expect(mod.codemode).toBeUndefined()
		expect(mod.capabilities).toBeUndefined()
		expect(mod.default.codemode).toBeUndefined()
		expect(mod.default.capabilities).toBeUndefined()

		const echoKody = {
			kody: {
				async tool_call(args: unknown) {
					return { ok: true, args }
				},
			},
		}
		await expect(
			storage.run(echoKody, async () => {
				if (!mod.kody) throw new Error('kody missing')
				return await mod.kody.tool_call({ value: 'active-store' })
			}),
		).resolves.toEqual({ ok: true, args: { value: 'active-store' } })
		await expect(
			storage.run(echoKody, async () => {
				if (!mod.default.kody) throw new Error('default kody missing')
				return await mod.default.kody.tool_call({
					value: 'default-active-store',
				})
			}),
		).resolves.toEqual({ ok: true, args: { value: 'default-active-store' } })

		for (const [packageContext, expected] of [
			[{ packageId: 'pkg-a' }, 'pkg-a'],
			[{ packageId: 'pkg-b' }, 'pkg-b'],
			[null, null],
		] as const) {
			expect(
				storage.run(
					{ packageContext },
					() => mod.packageContext?.packageId ?? null,
				),
			).toBe(expected)
		}

		const secretsRuntime = (prefix: string) => ({
			packageSecrets: {
				async get(alias: string) {
					return `${prefix}:${alias}`
				},
			},
		})
		expect(
			storage.run(secretsRuntime('a'), () => 'get' in mod.packageSecrets),
		).toBe(true)
		for (const prefix of ['a', 'b']) {
			await expect(
				storage.run(secretsRuntime(prefix), () =>
					mod.packageSecrets.get('token'),
				),
			).resolves.toBe(`${prefix}:token`)
		}
		expect(
			storage.run({ packageSecrets: null }, () => 'get' in mod.packageSecrets),
		).toBe(false)
	})
})

test('preloaded kody.mcp survives bundler-style destructuring of server names', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const result = await storage.run(
			{
				// Match the pre-fix sandbox shape: kody.mcp is a get-only proxy
				// with no has/ownKeys/getOwnPropertyDescriptor traps.
				kody: new Proxy(
					{},
					{
						get(_target, property) {
							if (property !== 'mcp') return undefined
							return new Proxy(
								{},
								{
									get(_mcpTarget, serverName) {
										if (serverName !== 'home') return undefined
										return {
											async sonos_list_players() {
												return { players: ['Kitchen'] }
											},
										}
									},
								},
							)
						},
					},
				),
			},
			async () => {
				const { home } = kodyMcp()
				return await home!.sonos_list_players!({})
			},
		)
		expect(result).toEqual({ players: ['Kitchen'] })
	})
})

test('bundler-style destructure of a missing kody.mcp server late-binds to the calling run', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const emptyMcp = new Proxy(
			{},
			{
				get() {
					return undefined
				},
				getOwnPropertyDescriptor() {
					return undefined
				},
			},
		)
		const captured = storage.run(
			{
				kody: new Proxy(
					{},
					{
						get: (_target, property) =>
							property === 'mcp' ? emptyMcp : undefined,
					},
				),
			},
			() => kodyMcp().home!,
		)

		const result = await storage.run(
			{
				kody: {
					mcp: {
						home: {
							async bond_shade_set_position(args: unknown) {
								return { ok: true, args }
							},
						},
					},
				},
			},
			async () =>
				await captured.bond_shade_set_position!({
					deviceId: '8b1242b1616ed0f7',
					position: 0,
				}),
		)
		expect(result).toEqual({
			ok: true,
			args: { deviceId: '8b1242b1616ed0f7', position: 0 },
		})
	})
})

test('destructured kody.mcp tools resolve against the calling run', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const homeRuntime = (run: string) => ({
			kody: {
				mcp: {
					home: {
						async sonos_list_players() {
							return { run }
						},
					},
				},
			},
		})
		const captured = storage.run(homeRuntime('first'), () => {
			const { home } = kodyMcp()
			const { sonos_list_players } = home!
			return { home: home!, sonos_list_players: sonos_list_players! }
		})

		const result = await storage.run(homeRuntime('second'), async () => ({
			viaHome: await captured.home.sonos_list_players!({}),
			viaTool: await captured.sonos_list_players({}),
		}))
		expect(result).toEqual({
			viaHome: { run: 'second' },
			viaTool: { run: 'second' },
		})
	})
})

test('kody.mcp tool calls stay callable when the current run throws on Get', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const oauthWaitingMessage =
			'The MCP server "home" is waiting for OAuth authorization. Complete the authorization from /account/mcp-servers. Check mcpServerList for connection status.'
		const authenticatingHomeRuntime = () => ({
			kody: {
				mcp: createKodyRemoteProxy({
					entries: [
						{
							name: 'home',
							status: {
								state: 'authenticating',
								connected: false,
								toolCount: 0,
								message:
									'The MCP server "home" is waiting for OAuth authorization. Complete the authorization from /account/mcp-servers.',
								unavailableMessage: oauthWaitingMessage,
							},
							capabilities: [],
						},
					],
					async callTool() {
						throw new Error('authenticating servers must not dispatch')
					},
				}),
			},
		})

		const captured = storage.run(authenticatingHomeRuntime(), () => {
			// createKodyRemoteProxy throws on Get; the isolate stand-in is
			// callable and rethrows that same message on the call, not as a
			// TypeError "is not a function".
			const mcp = kodyMcp()
			expect(Object.keys(mcp)).toEqual(['home'])
			expect(Object.keys(mcp.home!)).toEqual([])
			for (const tool of [
				'venstar_get_thermostat_info',
				'sonos_list_players',
			]) {
				expect(() => mcp.home![tool]!({})).toThrow(oauthWaitingMessage)
			}
			const { home } = mcp
			const { venstar_get_thermostat_info } = home!
			expect(typeof venstar_get_thermostat_info).toBe('function')
			expect(() => venstar_get_thermostat_info!({})).toThrow(
				oauthWaitingMessage,
			)
			return {
				home: home!,
				venstar_get_thermostat_info: venstar_get_thermostat_info!,
			}
		})

		const result = await storage.run(
			{
				kody: {
					mcp: {
						home: {
							async venstar_get_thermostat_info(args: unknown) {
								return { ok: true, args }
							},
						},
					},
				},
			},
			async () => ({
				serverNames: Object.keys(kodyMcp()),
				toolNames: Object.keys(kodyMcp().home!),
				viaHome: await captured.home.venstar_get_thermostat_info!({
					thermostat: 'office',
				}),
				viaTool: await captured.venstar_get_thermostat_info({
					thermostat: 'office',
				}),
			}),
		)
		expect(result).toEqual({
			serverNames: ['home'],
			toolNames: ['venstar_get_thermostat_info'],
			viaHome: { ok: true, args: { thermostat: 'office' } },
			viaTool: { ok: true, args: { thermostat: 'office' } },
		})
	})
})

test('secret-authority stamps stay visible across hydrated runtime.js copies', async () => {
	await withRuntimeIsolationCleanup(async ({ writeTempFiles }) => {
		const siblingPath =
			'.__kody_packages__/pkg/.__published_bundle__/2e/.__kody_virtual__/runtime.js'
		const urls = await writeTempFiles({
			'.__kody_virtual__/runtime.js': runtimeSource,
			[siblingPath]: createRuntimeModuleReexportSource(siblingPath),
		})
		const rootCopy = (await import(
			urls['.__kody_virtual__/runtime.js'] ?? ''
		)) as RuntimeModule
		const siblingCopy = (await import(urls[siblingPath] ?? '')) as RuntimeModule
		const globals = globalThis as unknown as GlobalSymbols

		expect(globals[Symbol.for('kody.secretAuthorityStorage')]).toBeUndefined()

		const peek = siblingCopy.__kodyGetSecretAuthority
		const stamped = siblingCopy.__kodyMeterStaticPackageExport(
			'pkg-artifact',
			() => peek(),
		)
		expect(stamped()).toBe('pkg-artifact')
		expect(peek()).toBeNull()

		const stampedOnRoot = rootCopy.__kodyMeterStaticPackageExport(
			'pkg-root',
			() => rootCopy.__kodyGetSecretAuthority(),
		)
		expect(stampedOnRoot()).toBe('pkg-root')

		class ArtifactClass {
			authority: string | null
			constructor() {
				this.authority = peek()
			}
		}
		const Wrapped = siblingCopy.__kodyMeterStaticPackageExport(
			'pkg-ctor',
			ArtifactClass,
		)
		expect(new Wrapped().authority).toBe('pkg-ctor')
		expect(peek()).toBeNull()

		globals[Symbol.for('kody.secretAuthorityStorage')] = {
			getStore: () => 'pkg-forged',
			run: (_packageId: string, callback: () => string) => callback(),
		}
		expect(stamped()).toBe('pkg-artifact')
		expect(peek()).toBeNull()

		// constructor.name is package-controlled; null must not break metering
		// or async ALS selection (intrinsic prototype is used instead).
		const syncNullCtor = () => peek()
		Object.defineProperty(syncNullCtor, 'constructor', { value: null })
		expect(
			siblingCopy.__kodyMeterStaticPackageExport(
				'pkg-null-ctor',
				syncNullCtor,
			)(),
		).toBe('pkg-null-ctor')

		const asyncNullCtor = async () => {
			await Promise.resolve()
			return peek()
		}
		Object.defineProperty(asyncNullCtor, 'constructor', { value: null })
		expect(
			await siblingCopy.__kodyMeterStaticPackageExport(
				'pkg-async-null-ctor',
				asyncNullCtor,
			)(),
		).toBe('pkg-async-null-ctor')
		expect(peek()).toBeNull()
	})
})

test('runtime evaluation replaces a configurable pre-planted authority forge', async () => {
	const authoritySymbol = Symbol.for('kody.getSecretAuthority')
	const callAuthority = () => {
		const authority = (
			globalThis as unknown as Record<symbol, (() => string | null) | undefined>
		)[authoritySymbol]
		if (!authority) throw new Error('Expected a secret authority getter.')
		return authority()
	}
	const existing = Object.getOwnPropertyDescriptor(globalThis, authoritySymbol)
	if (existing && !existing.configurable) {
		// A prior sealed install already applied — still prove redefine is denied.
		expect(() =>
			Object.defineProperty(globalThis, authoritySymbol, {
				value: () => 'pkg-forged',
				configurable: true,
			}),
		).toThrow(/Cannot redefine|configurable/i)
		return
	}

	Object.defineProperty(globalThis, authoritySymbol, {
		value: () => 'pkg-forged',
		configurable: true,
		writable: true,
		enumerable: false,
	})
	expect(callAuthority()).toBe('pkg-forged')

	await withRuntimeIsolationCleanup(async ({ writeRuntimeFile }) => {
		await import(`${await writeRuntimeFile()}?t=${Date.now()}`)
		expect(
			Object.getOwnPropertyDescriptor(globalThis, authoritySymbol)
				?.configurable,
		).toBe(false)
		expect(callAuthority()).not.toBe('pkg-forged')
	})
})

test('module secret-authority export ignores a sealed foreign global forge', async () => {
	const { Worker } = await import('node:worker_threads')
	const source = createRuntimeModuleSource()
	const result = await new Promise<{
		ok: boolean
		error: string
		globalValue: string | null
		moduleValue: string | null
	}>((resolve, reject) => {
		const worker = new Worker(
			`
import { parentPort } from 'node:worker_threads'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const authoritySymbol = Symbol.for('kody.getSecretAuthority')
Object.defineProperty(globalThis, authoritySymbol, {
	value: () => 'pkg-forged',
	configurable: false,
	writable: false,
	enumerable: false,
})
const filePath = join(tmpdir(), \`kody-sa-sealed-\${Date.now()}.mjs\`)
writeFileSync(filePath, ${JSON.stringify(source)})
try {
	const mod = await import(pathToFileURL(filePath).href)
	const globalValue =
		typeof globalThis[authoritySymbol] === 'function'
			? globalThis[authoritySymbol]()
			: null
	const moduleValue =
		typeof mod.__kodyGetSecretAuthority === 'function'
			? mod.__kodyGetSecretAuthority()
			: null
	parentPort.postMessage({
		ok: globalValue === 'pkg-forged' && moduleValue === null,
		error: '',
		globalValue,
		moduleValue,
	})
} catch (error) {
	parentPort.postMessage({
		ok: false,
		error: String(error),
		globalValue: null,
		moduleValue: null,
	})
} finally {
	try {
		rmSync(filePath, { force: true })
	} catch {
		// ignore cleanup failures in the worker
	}
}
`,
			{ eval: true },
		)
		worker.on('message', resolve)
		worker.on('error', reject)
		worker.on('exit', (code) => {
			if (code !== 0) {
				reject(
					new Error(`sealed-forge worker exited with code ${String(code)}`),
				)
			}
		})
	})
	expect(result.error).toBe('')
	expect(result.ok).toBe(true)
	expect(result.globalValue).toBe('pkg-forged')
	expect(result.moduleValue).toBeNull()
})
