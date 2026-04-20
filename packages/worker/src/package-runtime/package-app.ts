import { exports as workerExports } from 'cloudflare:workers'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	getPackageAppEntryPath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import { buildCodemodeFns } from '#mcp/run-codemode-registry.ts'
import {
	createAuthenticatedFetch,
	refreshAccessToken,
} from '#mcp/execute-modules/codemode-utils.ts'
import { buildKodyModuleBundle } from './module-graph.ts'

const packageAppEntrypointName = 'PackageAppWorker'

function createPackageAppWorkerSource(input: { mainModule: string }) {
	return `
import { WorkerEntrypoint } from 'cloudflare:workers';

export class ${packageAppEntrypointName} extends WorkerEntrypoint {
	async fetch(request) {
		const previousRuntime = globalThis.__kodyRuntime;
		globalThis.__kodyRuntime = this.env.__kodyRuntimeBootstrap ?? {};
		try {
			const userModule = await import(${JSON.stringify(`./${input.mainModule}`)});
			const candidate = userModule.default ?? userModule;
		const fetchHandler =
			typeof candidate === 'function'
				? candidate
				: candidate && typeof candidate.fetch === 'function'
					? candidate.fetch.bind(candidate)
					: null;
		if (!fetchHandler) {
			throw new Error('Package apps must default export a fetch handler or an object with fetch().');
		}
		return await fetchHandler(request);
		} finally {
			if (previousRuntime === undefined) delete globalThis.__kodyRuntime;
			else globalThis.__kodyRuntime = previousRuntime;
		}
	}
}
`.trim()
}

function createPackageAppRuntimeBootstrap(input: {
	codemode: Record<string, (args: unknown) => Promise<unknown>>
	params: Record<string, unknown> | null
	storage: {
		id: string
		get: (key: string) => Promise<unknown>
		list: (options?: Record<string, unknown>) => Promise<unknown>
		sql: (query: string, params?: Array<unknown>) => Promise<unknown>
		set: (key: string, value: unknown) => Promise<unknown>
		delete: (key: string) => Promise<unknown>
		clear: () => Promise<unknown>
	}
	refreshAccessToken: (providerName: string) => Promise<string>
	createAuthenticatedFetch: (
		providerName: string,
	) => Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
	agentChatTurnStream: (input: Record<string, unknown>) => AsyncIterable<unknown>
	packageContext: {
		packageId: string
		kodyId: string
	}
}) {
	return {
		codemode: input.codemode,
		params: input.params,
		storage: input.storage,
		refreshAccessToken: input.refreshAccessToken,
		createAuthenticatedFetch: input.createAuthenticatedFetch,
		agentChatTurnStream: input.agentChatTurnStream,
		packageContext: input.packageContext,
	}
}

function createPackageStorage(input: {
	codemode: Record<string, (args: unknown) => Promise<unknown>>
	storageId: string
}) {
	const storageGet = input.codemode['storage_get']
	const storageList = input.codemode['storage_list']
	const storageSql = input.codemode['storage_sql']
	const storageSet = input.codemode['storage_set']
	const storageDelete = input.codemode['storage_delete']
	const storageClear = input.codemode['storage_clear']
	if (
		typeof storageGet !== 'function' ||
		typeof storageList !== 'function' ||
		typeof storageSql !== 'function' ||
		typeof storageSet !== 'function' ||
		typeof storageDelete !== 'function' ||
		typeof storageClear !== 'function'
	) {
		throw new Error('Package app runtime storage helpers are unavailable.')
	}
	return {
		id: input.storageId,
		get: async (key: string) =>
			(await storageGet({ key })) as unknown,
		list: async (options: Record<string, unknown> = {}) =>
			await storageList(options),
		sql: async (query: string, params: Array<unknown> = []) =>
			await storageSql({
				query,
				params,
				writable: true,
			}),
		set: async (key: string, value: unknown) =>
			await storageSet({ key, value }),
		delete: async (key: string) => await storageDelete({ key }),
		clear: async () => await storageClear({}),
	}
}

function createAgentChatTurnStream(input: {
	codemode: Record<string, (args: unknown) => Promise<unknown>>
}) {
	const startTurn = input.codemode['agent_turn_start']
	const nextTurn = input.codemode['agent_turn_next']
	const cancelTurn = input.codemode['agent_turn_cancel']
	if (
		typeof startTurn !== 'function' ||
		typeof nextTurn !== 'function' ||
		typeof cancelTurn !== 'function'
	) {
		throw new Error('Package app runtime agent turn helpers are unavailable.')
	}
	return async function* agentChatTurnStream(args: Record<string, unknown>) {
		const start = await startTurn(args)
		const startPayload = start as {
			ok?: boolean
			runId?: string
			sessionId?: string
		}
		if (
			!startPayload.ok ||
			typeof startPayload.runId !== 'string' ||
			typeof startPayload.sessionId !== 'string'
		) {
			throw new Error(
				'agent_turn_start did not return a valid run id and session id.',
			)
		}
		let cursor = 0
		let done = false
		try {
			while (!done) {
				const next = (await nextTurn({
					sessionId: startPayload.sessionId,
					runId: startPayload.runId,
					cursor,
				})) as {
					events?: Array<unknown>
					nextCursor?: number
					done?: boolean
				}
				const events = Array.isArray(next.events) ? next.events : []
				cursor =
					typeof next.nextCursor === 'number' ? next.nextCursor : cursor
				for (const event of events) {
					yield event
				}
				done = next.done === true
			}
		} finally {
			if (!done) {
				await cancelTurn({
						sessionId: startPayload.sessionId,
						runId: startPayload.runId,
					})
					.catch(() => {
						// Best effort only.
					})
			}
		}
	}
}

export async function buildPackageAppWorker(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: {
		id: string
		kodyId: string
		name: string
		sourceId: string
	}
	sourceFiles: Record<string, string>
	params?: Record<string, unknown>
	runtime: {
		callerContext: ReturnType<typeof createMcpCallerContext>
	}
}) {
	const packageJsonContent = input.sourceFiles['package.json']
	if (!packageJsonContent) {
		throw new Error('Saved package is missing package.json.')
	}
	const manifest = parseAuthoredPackageJson({
		content: packageJsonContent,
		manifestPath: 'package.json',
	})
	const appEntry = getPackageAppEntryPath(manifest)
	if (!appEntry) {
		throw new Error(
			`Saved package "${input.savedPackage.kodyId}" does not define kody.app.entry.`,
		)
	}
	const bundled = await buildKodyModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: appEntry,
	})
	const codemode = await buildCodemodeFns(
		input.env,
		input.runtime.callerContext,
		{
			storageTools: {
				userId: input.userId,
				storageId: input.savedPackage.id,
				writable: true,
			},
		},
	)
	const runtimeBootstrap = createPackageAppRuntimeBootstrap({
		codemode,
		params: input.params ?? null,
		storage: createPackageStorage({
			codemode,
			storageId: input.savedPackage.id,
		}),
		refreshAccessToken: async (providerName: string) =>
			await refreshAccessToken(codemode, providerName),
		createAuthenticatedFetch: async (providerName: string) =>
			await createAuthenticatedFetch(codemode, providerName),
		agentChatTurnStream: createAgentChatTurnStream({
			codemode,
		}),
		packageContext: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
		},
	})
	const mainModule = 'package-app-entry.js'
	const modules = {
		...bundled.modules,
		[mainModule]: createPackageAppWorkerSource({
			mainModule: bundled.mainModule,
		}),
	}
	return {
		stub: input.env.APP_LOADER.load({
			compatibilityDate: '2026-04-13',
			compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
			mainModule,
			modules,
			env: {
				__kodyRuntimeBootstrap: runtimeBootstrap,
			},
			globalOutbound: workerExports?.CodemodeFetchGateway
				? workerExports.CodemodeFetchGateway({
						props: {
							baseUrl: input.baseUrl,
							userId: input.userId,
							storageContext: {
								sessionId: null,
								appId: input.savedPackage.id,
								storageId: input.savedPackage.id,
							},
						},
					})
				: null,
		}),
		entrypointName: packageAppEntrypointName,
	}
}

export async function createPackageAppCallerContext(input: {
	baseUrl: string
	user: {
		userId: string
		email: string
		displayName?: string
	}
	packageId: string
}) {
	return createMcpCallerContext({
		baseUrl: input.baseUrl,
		user: {
			userId: input.user.userId,
			email: input.user.email,
			displayName:
				input.user.displayName ?? `package:${input.packageId}`,
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			storageId: input.packageId,
		},
	})
}
