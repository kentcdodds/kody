import { WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	getPackageAppEntryPath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	buildCodemodeFns,
	type PackageInvokeTools,
} from '#mcp/run-codemode-registry.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	createAuthenticatedFetch,
	refreshAccessToken,
} from '#mcp/execute-modules/codemode-utils.ts'
import {
	buildKodyAppBundle,
	createPublishedBundleArtifact,
	createPublishedPackageAppBundleCacheKey,
	hydrateKodyRuntimeModules,
} from './module-graph.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import {
	readPublishedBundleArtifact,
	writePublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { packageRealtimeSessionRpc } from './realtime-session.ts'
import {
	createDynamicCallableWorkflow,
	type PackageWorkflowCreateInput,
} from './package-workflows.ts'
import {
	listSavedPackageServices,
	normalizePackageServiceStatus,
	packageServiceRpc,
} from './package-service.ts'
import {
	isPackageSecretAccessUnavailableError,
	resolvePackageMountedSecret,
} from '#mcp/secrets/package-access.ts'
import {
	beginPackageRuntimeRun,
	finishPackageRuntimeRun,
	type PackageRuntimeRunHandle,
	type PackageRuntimeStatus,
} from './package-runtime-debug.ts'

const packageAppEntrypointName = 'PackageAppWorker'
const packageAppRuntimeBindingName = 'KODY_RUNTIME'

function createPackageAppWorkerSource(input: { mainModule: string }) {
	return `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';

const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
// Resolve the AsyncLocalStorage instance synchronously at module load,
// then publish it under the well-known symbol exactly once. The runtime
// virtual module reads the same symbol, so wrapper and user code are
// guaranteed to share the same ALS instance even when several requests
// race during cold start.
const __kodyRuntimeStorage = (() => {
	const globalAny = globalThis;
	const existing = globalAny[__kodyRuntimeStorageSymbol];
	if (existing) return existing;
	const created = new AsyncLocalStorage();
	globalAny[__kodyRuntimeStorageSymbol] = created;
	return created;
})();

function buildFacetName(rawFacetName) {
	return typeof rawFacetName === 'string' && rawFacetName.trim().length > 0
		? rawFacetName.trim()
		: 'main';
}

function fnv1a32(input) {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function buildFacetClassExportName(rawFacetName) {
	const canonicalName = buildFacetName(rawFacetName);
	const sanitizedFacetName = canonicalName.replace(/[^a-zA-Z0-9_]/g, '_');
	const hashSuffix = fnv1a32(canonicalName).toString(16).padStart(8, '0');
	return canonicalName === 'main'
		? 'App'
		: \`App_\${sanitizedFacetName}_\${hashSuffix}\`;
}

function createCodemodeProxy(runtimeBridge) {
	return new Proxy({}, {
		get(_target, property) {
			if (typeof property !== 'string') return undefined;
			return async (args = {}) =>
				await runtimeBridge.callCapability({
					name: property,
					args,
				});
		},
	});
}

function createStorageProxy(runtimeBridge, storageId) {
	return {
		id: storageId,
		get: async (key) =>
			(await runtimeBridge.storageGet({
				storageId,
				key,
			})).value,
		list: async (options = {}) =>
			await runtimeBridge.storageList({
				storageId,
				...options,
			}),
		sql: async (query, params = []) =>
			await runtimeBridge.storageSql({
				storageId,
				query,
				params,
				writable: true,
			}),
		set: async (key, value) =>
			await runtimeBridge.storageSet({
				storageId,
				key,
				value,
			}),
		delete: async (key) =>
			await runtimeBridge.storageDelete({
				storageId,
				key,
			}),
		clear: async () =>
			await runtimeBridge.storageClear({
				storageId,
			}),
	}
}

function createRealtimeProxy(runtimeBridge) {
	return {
		emit: async (sessionId, data) =>
			await runtimeBridge.realtimeEmit({
				sessionId,
				data,
			}),
		broadcast: async (input = {}) =>
			await runtimeBridge.realtimeBroadcast({
				data: input.data,
				topic: input.topic,
				facet: input.facet,
			}),
		listSessions: async (input = {}) =>
			await runtimeBridge.realtimeListSessions({
				topic: input.topic,
				facet: input.facet,
			}),
		disconnect: async (sessionId, input = {}) =>
			await runtimeBridge.realtimeDisconnect({
				sessionId,
				code: input.code,
				reason: input.reason,
			}),
	};
}

function createServicesProxy(runtimeBridge) {
	return {
		list: async () => await runtimeBridge.serviceList(),
		get: async (serviceName) =>
			await runtimeBridge.serviceGet({
				serviceName,
			}),
		start: async (serviceName) =>
			await runtimeBridge.serviceStart({
				serviceName,
			}),
		stop: async (serviceName) =>
			await runtimeBridge.serviceStop({
				serviceName,
			}),
	};
}

function createPackageSecretsProxy(runtimeBridge) {
	return {
		get: async (alias) => {
			const normalizedAlias =
				typeof alias === 'string' ? alias.trim() : ''
			if (!normalizedAlias) {
				throw new Error('packageSecrets.get requires a non-empty alias.')
			}
			const result = await runtimeBridge.packageSecretGet({
				alias: normalizedAlias,
			})
			if (typeof result?.value !== 'string') {
				throw new Error(
					'packageSecretGet returned invalid response for alias "' +
						normalizedAlias +
						'".',
				)
			}
			return result.value
		},
		has: async (alias) => {
			const normalizedAlias =
				typeof alias === 'string' ? alias.trim() : ''
			if (!normalizedAlias) {
				throw new Error('packageSecrets.has requires a non-empty alias.')
			}
			const result = await runtimeBridge.packageSecretHas({
				alias: normalizedAlias,
			})
			if (typeof result?.has !== 'boolean') {
				throw new Error(
					'packageSecretHas returned invalid response for alias "' +
						normalizedAlias +
						'".',
				)
			}
			return result.has
		},
	};
}

function createWorkflowsProxy(runtimeBridge) {
	const isoRunAtPattern =
		/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
	const normalizeOptionalString = (input, fieldName) => {
		const value = input?.[fieldName];
		return typeof value === 'string' && value.trim() ? value : null;
	};
	const normalizeRequiredString = (input, fieldName) => {
		const value = normalizeOptionalString(input, fieldName);
		if (!value) throw new Error('workflows.create requires a non-empty ' + fieldName + '.');
		return value;
	};
	const normalizeRunAt = (input) => {
		const value = input?.runAt;
		const date =
			value instanceof Date
				? value
				: typeof value === 'string'
					? isoRunAtPattern.test(value)
						? new Date(value)
						: null
					: null;
		if (!date || Number.isNaN(date.getTime())) {
			throw new Error(
				'workflows.create requires a valid runAt ISO-8601 date-time string or Date.',
			);
		}
		return date;
	};
	return {
		create: async (input) => {
			if (!input || typeof input !== 'object' || Array.isArray(input)) {
				throw new Error('workflows.create requires a workflow input object.');
			}
			const exportName = normalizeOptionalString(input, 'exportName');
			const code = normalizeOptionalString(input, 'code');
			if ((exportName ? 1 : 0) + (code ? 1 : 0) !== 1) {
				throw new Error('workflows.create requires exactly one of exportName or code.');
			}
			const workflowName = normalizeOptionalString(input, 'workflowName');
			const packageId = normalizeOptionalString(input, 'packageId');
			const payload = {
				runAt: normalizeRunAt(input),
				idempotencyKey: normalizeRequiredString(input, 'idempotencyKey'),
				...(input.params === undefined ? {} : { params: input.params }),
				...(workflowName ? { workflowName } : {}),
				...(packageId ? { packageId } : {}),
				...(exportName ? { exportName } : {}),
				...(code ? { code } : {}),
			};
			return await runtimeBridge.workflowCreate(payload);
		},
	};
}

function createPackagesProxy(runtimeBridge) {
	return {
		check: async (input) => await runtimeBridge.packageInvokeCheck(input ?? {}),
		invoke: async (input) => await runtimeBridge.packageInvoke(input ?? {}),
		invokeChecked: async (input) =>
			await runtimeBridge.packageInvokeChecked(input ?? {}),
	};
}

function createAuthenticatedFetchHelper(runtimeBridge) {
	return async function createAuthenticatedFetch(providerName) {
		return async (input, init) =>
			await runtimeBridge.authenticatedFetch({
				providerName,
				request: {
					url:
						typeof input === 'string'
							? input
							: input instanceof URL
								? input.toString()
								: input.url,
					method:
						input instanceof Request
							? input.method
							: init?.method ?? 'GET',
					headers: Object.fromEntries(
						new Headers(input instanceof Request ? input.headers : init?.headers).entries(),
					),
					body:
						input instanceof Request
							? await input.text()
							: typeof init?.body === 'string'
								? init.body
								: undefined,
				},
			});
	}
}

function createInternalDurableObjectState(runtimeBridge, storageId) {
	const listToMap = async (options = {}) => {
		const result = await runtimeBridge.storageList({
			storageId,
			...options,
		});
		return new Map((result?.entries ?? []).map((entry) => [entry.key, entry.value]));
	};
	return {
		id: {
			toString() {
				return storageId;
			},
		},
		blockConcurrencyWhile: async (fn) => await fn(),
		waitUntil() {},
		storage: {
			get: async (key) =>
				(await runtimeBridge.storageGet({
					storageId,
					key,
				})).value,
			put: async (key, value) =>
				await runtimeBridge.storageSet({
					storageId,
					key,
					value,
				}),
			delete: async (key) =>
				await runtimeBridge.storageDelete({
					storageId,
					key,
				}),
			deleteAll: async () =>
				await runtimeBridge.storageClear({
					storageId,
				}),
			list: async (options = {}) => await listToMap(options),
			sql: {
				databaseSize: 0,
			},
		},
	};
}

function createDurableObjectNamespace(runtimeBridge, runtimeEnv, packageId, exportName, ExportedClass) {
	return {
		idFromName(name) {
			return \`\${packageId}:\${exportName}:\${String(name)}\`;
		},
		get(id) {
			const storageId = String(id);
			return {
				fetch: async (request) => {
					const state = createInternalDurableObjectState(runtimeBridge, storageId);
					// Package-internal Durable Objects are an implementation detail.
					// Build an instance shape with the fields user code typically reads
					// (\`ctx\` and \`env\`) without requiring a native DurableObjectState.
					const instance = Object.create(ExportedClass.prototype);
					instance.ctx = state;
					instance.env = runtimeEnv;
					if (typeof instance.fetch !== 'function') {
						throw new Error(\`Package Durable Object "\${exportName}" must implement fetch().\`);
					}
					return await instance.fetch(request);
				},
			};
		},
	};
}

function createPackageAppEnv(env, userModule) {
	const runtimeBridge = env.${packageAppRuntimeBindingName};
	const packageContext = env.__kodyPackageContext ?? null;
	const packageId = packageContext?.packageId ?? '';
	const runtimeEnv = Object.create(env);
	for (const [exportName, exported] of Object.entries(userModule)) {
		if (exportName !== 'default' && typeof exported === 'function') {
			const namespace = createDurableObjectNamespace(
				runtimeBridge,
				runtimeEnv,
				packageId,
				exportName,
				exported,
			);
			runtimeEnv[exportName] = namespace;
			runtimeEnv[exportName.toUpperCase()] = namespace;
		}
	}
	return runtimeEnv;
}

function createRuntime(runtimeBridge, packageContext) {
	const packageId = packageContext?.packageId ?? '';
	const packageSecrets =
		packageId.length > 0
			? createPackageSecretsProxy(runtimeBridge)
			: {
					get: async () => {
						throw new Error(
							'packageSecrets.get requires a package runtime context.',
						)
					},
					has: async () => {
						throw new Error(
							'packageSecrets.has requires a package runtime context.',
						)
					},
				}
	return {
		codemode: createCodemodeProxy(runtimeBridge),
		storage: createStorageProxy(runtimeBridge, packageId),
		refreshAccessToken: async (providerName) =>
			await runtimeBridge.refreshAccessToken(providerName),
		createAuthenticatedFetch: createAuthenticatedFetchHelper(runtimeBridge),
		realtime: createRealtimeProxy(runtimeBridge),
		services: createServicesProxy(runtimeBridge),
		packageSecrets,
		workflows: createWorkflowsProxy(runtimeBridge),
		packages: createPackagesProxy(runtimeBridge),
		packageContext,
	};
}

function createFacetStorageId(packageContext, facetName) {
	const packageId = packageContext?.packageId ?? 'package';
	return \`\${packageId}:facet:\${buildFacetName(facetName)}\`;
}

function serializeRuntimeError(error) {
	return {
		name: error && typeof error.name === 'string' ? error.name : 'Error',
		message:
			error && typeof error.message === 'string'
				? error.message
				: String(error),
	};
}

async function startRuntimeRun(runtimeBridge, input) {
	return await runtimeBridge.packageRuntimeRunStart(input).catch(() => null);
}

async function finishRuntimeRun(runtimeBridge, input) {
	await runtimeBridge.packageRuntimeRunFinish(input).catch(() => {});
}

function resolveRealtimeHandler(userModule, facetName) {
	const facetExportName = buildFacetClassExportName(facetName);
	if (typeof userModule[facetExportName] === 'function') {
		return {
			kind: 'class',
			exported: userModule[facetExportName],
		};
	}
	if (typeof userModule.handleRealtimeEvent === 'function') {
		return {
			kind: 'function',
			exported: userModule.handleRealtimeEvent,
		};
	}
	const candidate = userModule.default ?? userModule;
	if (candidate && typeof candidate.onRealtimeEvent === 'function') {
		return {
			kind: 'bound-method',
			exported: candidate,
		};
	}
	if (typeof candidate === 'function' && typeof candidate.prototype?.onRealtimeEvent === 'function') {
		return {
			kind: 'class',
			exported: candidate,
		};
	}
	return null;
}

export class ${packageAppEntrypointName} extends WorkerEntrypoint {
	async fetch(request) {
		const runtimeBridge = this.env.${packageAppRuntimeBindingName};
		const runtimeRun = await startRuntimeRun(runtimeBridge, {
			surface: 'app_fetch',
			name: new URL(request.url).pathname,
			metadata: {
				method: request.method,
			},
		});
		const runtime = createRuntime(
			runtimeBridge,
			this.env.__kodyPackageContext ?? null,
		);
		try {
			const response = await __kodyRuntimeStorage.run(runtime, async () => {
				const userModule = await import(${JSON.stringify(`./${input.mainModule}`)});
				const runtimeEnv = createPackageAppEnv(this.env, userModule);
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
				return await fetchHandler(request, runtimeEnv, this.ctx);
			});
			await finishRuntimeRun(runtimeBridge, {
				run: runtimeRun,
				status: 'success',
			});
			return response;
		} catch (error) {
			await finishRuntimeRun(runtimeBridge, {
				run: runtimeRun,
				status: 'error',
				error: serializeRuntimeError(error),
			});
			throw error;
		}
	}

	async handleRealtimeEvent(payload) {
		const runtimeBridge = this.env.${packageAppRuntimeBindingName};
		const runtimeRun = await startRuntimeRun(runtimeBridge, {
			surface: 'app_realtime',
			name: buildFacetName(payload?.facet),
			sessionId: payload?.sessionId,
			metadata: {
				facet: payload?.facet,
				topic: payload?.topic,
			},
		});
		const runtime = createRuntime(
			runtimeBridge,
			this.env.__kodyPackageContext ?? null,
		);
		try {
			const result = await __kodyRuntimeStorage.run(runtime, async () => {
				const userModule = await import(${JSON.stringify(`./${input.mainModule}`)});
				const runtimeEnv = createPackageAppEnv(this.env, userModule);
				const resolved = resolveRealtimeHandler(userModule, payload?.facet);
				if (!resolved) {
					return { actions: [] };
				}
				if (resolved.kind === 'function') {
					return await resolved.exported(payload, runtimeEnv, this.ctx);
				}
				if (resolved.kind === 'bound-method') {
					return await resolved.exported.onRealtimeEvent(payload, runtimeEnv, this.ctx);
				}
				const state = createInternalDurableObjectState(
					runtimeBridge,
					createFacetStorageId(this.env.__kodyPackageContext ?? null, payload?.facet),
				);
				const instance = Object.create(resolved.exported.prototype);
				instance.ctx = state;
				instance.env = runtimeEnv;
				if (typeof instance.onRealtimeEvent !== 'function') {
					throw new Error(\`Package app facet "\${buildFacetName(payload?.facet)}" must implement onRealtimeEvent().\`);
				}
				return await instance.onRealtimeEvent(payload, runtimeEnv, this.ctx);
			});
			await finishRuntimeRun(runtimeBridge, {
				run: runtimeRun,
				status: 'success',
			});
			return result;
		} catch (error) {
			await finishRuntimeRun(runtimeBridge, {
				run: runtimeRun,
				status: 'error',
				error: serializeRuntimeError(error),
			});
			throw error;
		}
	}
}
`.trim()
}

type PackageAppRuntimeBridgeProps = {
	baseUrl: string
	userId: string
	email: string
	displayName: string
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
}

export class PackageAppRuntimeBridge extends WorkerEntrypoint<
	Env,
	PackageAppRuntimeBridgeProps
> {
	private packageRuntimeInvokeTools: Promise<PackageInvokeTools> | null = null

	private createCallerContext(storageId: string | null) {
		return createMcpCallerContext({
			baseUrl: this.ctx.props.baseUrl,
			user: {
				userId: this.ctx.props.userId,
				email: this.ctx.props.email,
				username: undefined,
				displayName: this.ctx.props.displayName,
			},
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.packageId,
				storageId,
			},
		})
	}

	private getStorageRunner(storageId: string) {
		return storageRunnerRpc({
			env: this.env,
			userId: this.ctx.props.userId,
			storageId,
		})
	}

	private getRealtimeSessionRpc() {
		return packageRealtimeSessionRpc({
			env: this.env,
			userId: this.ctx.props.userId,
			packageId: this.ctx.props.packageId,
			kodyId: this.ctx.props.kodyId,
			sourceId: this.ctx.props.sourceId,
			baseUrl: this.ctx.props.baseUrl,
		})
	}

	private getPackageServiceRpc(serviceName: string) {
		return packageServiceRpc({
			env: this.env,
			userId: this.ctx.props.userId,
			packageId: this.ctx.props.packageId,
			kodyId: this.ctx.props.kodyId,
			sourceId: this.ctx.props.sourceId,
			baseUrl: this.ctx.props.baseUrl,
			serviceName,
		})
	}

	async packageRuntimeRunStart(input: {
		surface: 'app_fetch' | 'app_realtime'
		name?: string | null
		sessionId?: string | null
		metadata?: Record<string, unknown> | null
	}): Promise<PackageRuntimeRunHandle | null> {
		return await beginPackageRuntimeRun({
			env: this.env,
			userId: this.ctx.props.userId,
			context: {
				packageId: this.ctx.props.packageId,
				kodyId: this.ctx.props.kodyId,
				sourceId: this.ctx.props.sourceId,
				publishedCommit: this.ctx.props.publishedCommit,
				surface: input.surface,
				name: input.name,
				sessionId: input.sessionId,
				metadata: input.metadata,
			},
		})
	}

	async packageRuntimeRunFinish(input: {
		run: PackageRuntimeRunHandle | null
		status: Exclude<PackageRuntimeStatus, 'running'>
		error?: unknown
		logs?: Array<string>
	}) {
		await finishPackageRuntimeRun({
			env: this.env,
			handle: input.run,
			status: input.status,
			error: input.error,
			logs: input.logs,
		})
		return { ok: true }
	}

	async callCapability(input: { name: string; args?: unknown }) {
		const name = input.name.trim()
		switch (name) {
			case 'storage_get':
				return await this.storageGet({
					storageId: this.ctx.props.packageId,
					key:
						typeof input.args === 'object' &&
						input.args !== null &&
						'key' in input.args
							? String((input.args as { key: unknown }).key ?? '')
							: '',
				})
			case 'storage_list':
				return await this.storageList({
					storageId: this.ctx.props.packageId,
					...(typeof input.args === 'object' && input.args !== null
						? (input.args as Record<string, unknown>)
						: {}),
				})
			case 'storage_sql':
				return await this.storageSql({
					storageId: this.ctx.props.packageId,
					query:
						typeof input.args === 'object' &&
						input.args !== null &&
						'query' in input.args
							? String((input.args as { query: unknown }).query ?? '')
							: '',
					params:
						typeof input.args === 'object' &&
						input.args !== null &&
						Array.isArray((input.args as { params?: unknown }).params)
							? ((input.args as { params: Array<unknown> }).params ?? [])
							: [],
					writable: true,
				})
			case 'storage_set':
				return await this.storageSet({
					storageId: this.ctx.props.packageId,
					key:
						typeof input.args === 'object' &&
						input.args !== null &&
						'key' in input.args
							? String((input.args as { key: unknown }).key ?? '')
							: '',
					value:
						typeof input.args === 'object' && input.args !== null
							? (input.args as { value?: unknown }).value
							: undefined,
				})
			case 'storage_delete':
				return await this.storageDelete({
					storageId: this.ctx.props.packageId,
					key:
						typeof input.args === 'object' &&
						input.args !== null &&
						'key' in input.args
							? String((input.args as { key: unknown }).key ?? '')
							: '',
				})
			case 'storage_clear':
				return await this.storageClear({
					storageId: this.ctx.props.packageId,
				})
		}
		const { capabilityMap } = await getCapabilityRegistryForContext({
			env: this.env,
			callerContext: this.createCallerContext(this.ctx.props.packageId),
		})
		const capability = capabilityMap[name]
		if (!capability) {
			throw new Error(`Package app capability "${name}" is not available.`)
		}
		return await capability.handler(
			(input.args ?? {}) as Record<string, unknown>,
			{
				env: this.env,
				callerContext: this.createCallerContext(this.ctx.props.packageId),
			},
		)
	}

	async storageGet(input: { storageId: string; key: string }) {
		return await this.getStorageRunner(input.storageId).getValue({
			key: input.key,
		})
	}

	async storageList(input: {
		storageId: string
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		return await this.getStorageRunner(input.storageId).listValues({
			prefix: input.prefix,
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	async storageSql(input: {
		storageId: string
		query: string
		params?: Array<unknown>
		writable?: boolean
	}) {
		return await this.getStorageRunner(input.storageId).sqlQuery({
			query: input.query,
			params: input.params,
			writable: input.writable ?? false,
		})
	}

	async storageSet(input: { storageId: string; key: string; value: unknown }) {
		return await this.getStorageRunner(input.storageId).setValue({
			key: input.key,
			value: input.value,
		})
	}

	async storageDelete(input: { storageId: string; key: string }) {
		return await this.getStorageRunner(input.storageId).deleteValue({
			key: input.key,
		})
	}

	async storageClear(input: { storageId: string }) {
		return await this.getStorageRunner(input.storageId).clearStorage()
	}

	async refreshAccessToken(providerName: string) {
		const codemode = await buildCodemodeFns(
			this.env,
			this.createCallerContext(this.ctx.props.packageId),
		)
		return await refreshAccessToken(codemode, providerName)
	}

	async authenticatedFetch(input: {
		providerName: string
		request: {
			url: string
			method?: string
			headers?: Record<string, string>
			body?: string
		}
	}) {
		const codemode = await buildCodemodeFns(
			this.env,
			this.createCallerContext(this.ctx.props.packageId),
		)
		const authenticatedFetch = await createAuthenticatedFetch(
			codemode,
			input.providerName,
		)
		return await authenticatedFetch(input.request.url, {
			method: input.request.method,
			headers: input.request.headers,
			body: input.request.body,
		})
	}

	async packageSecretGet(input: { alias: string }) {
		const callerContext = this.createCallerContext(this.ctx.props.packageId)
		const resolved = await resolvePackageMountedSecret({
			env: this.env,
			callerContext,
			packageId: this.ctx.props.packageId,
			alias: input.alias,
		})
		return {
			value: resolved.value,
		}
	}

	async packageSecretHas(input: { alias: string }) {
		const callerContext = this.createCallerContext(this.ctx.props.packageId)
		try {
			await resolvePackageMountedSecret({
				env: this.env,
				callerContext,
				packageId: this.ctx.props.packageId,
				alias: input.alias,
			})
			return {
				has: true,
			}
		} catch (error) {
			if (isPackageSecretAccessUnavailableError(error)) {
				return {
					has: false,
				}
			}
			throw error
		}
	}

	async realtimeEmit(input: { sessionId: string; data: unknown }) {
		return await this.getRealtimeSessionRpc().emit(input.sessionId, input.data)
	}

	async realtimeBroadcast(input: {
		data: unknown
		topic?: string | null
		facet?: string | null
	}) {
		return await this.getRealtimeSessionRpc().broadcast(input)
	}

	async realtimeListSessions(input?: {
		topic?: string | null
		facet?: string | null
	}) {
		return await this.getRealtimeSessionRpc().listSessions(input)
	}

	async realtimeDisconnect(input: {
		sessionId: string
		code?: number | null
		reason?: string | null
	}) {
		return await this.getRealtimeSessionRpc().disconnect(input.sessionId, {
			code: input.code ?? undefined,
			reason: input.reason ?? undefined,
		})
	}

	async serviceList() {
		const result = await listSavedPackageServices({
			env: this.env,
			userId: this.ctx.props.userId,
			baseUrl: this.ctx.props.baseUrl,
			packageId: this.ctx.props.packageId,
		})
		const services = await Promise.all(
			result.services.map(async (service) => {
				let status = 'unknown'
				try {
					status = normalizePackageServiceStatus(
						await this.getPackageServiceRpc(service.name).status(),
					).status
				} catch {
					// Keep the rest of the service list usable if one status lookup fails.
				}
				return {
					name: service.name,
					entry: service.entry,
					auto_start: service.autoStart,
					timeout_ms: service.timeoutMs ?? null,
					status,
				}
			}),
		)
		return {
			package_id: result.savedPackage.id,
			kody_id: result.savedPackage.kodyId,
			services,
		}
	}

	async serviceGet(input: { serviceName: string }) {
		return await this.getPackageServiceRpc(input.serviceName).status()
	}

	async serviceStart(input: { serviceName: string }) {
		return await this.getPackageServiceRpc(input.serviceName).start()
	}

	async serviceStop(input: { serviceName: string }) {
		return await this.getPackageServiceRpc(input.serviceName).stop()
	}

	async workflowCreate(input: unknown) {
		return await createDynamicCallableWorkflow({
			env: this.env,
			userId: this.ctx.props.userId,
			packageContext: {
				packageId: this.ctx.props.packageId,
				kodyId: this.ctx.props.kodyId,
				sourceId: this.ctx.props.sourceId,
			},
			body: input as PackageWorkflowCreateInput,
		})
	}

	async createPackageRuntimeInvokeTools() {
		if (this.packageRuntimeInvokeTools)
			return await this.packageRuntimeInvokeTools

		// Avoid a top-level package-app -> package-invocations cycle during worker
		// startup; apps only need this helper when package code calls it.
		this.packageRuntimeInvokeTools =
			import('#worker/package-invocations/service.ts').then(
				({ createPackageRuntimeInvokeTools }) => {
					const packageContext = {
						packageId: this.ctx.props.packageId,
						kodyId: this.ctx.props.kodyId,
						sourceId: this.ctx.props.sourceId,
					}
					return createPackageRuntimeInvokeTools({
						env: this.env,
						baseUrl: this.ctx.props.baseUrl,
						callerContext: this.createCallerContext(this.ctx.props.packageId),
						packageContext,
						parentRuntimeDebug: null,
						packageInvokeDepth: 0,
					})
				},
			)
		return await this.packageRuntimeInvokeTools
	}

	async packageInvoke(input: Record<string, unknown>) {
		const tools = await this.createPackageRuntimeInvokeTools()
		return await tools.invoke(input)
	}

	async packageInvokeCheck(input: Record<string, unknown>) {
		const tools = await this.createPackageRuntimeInvokeTools()
		return await tools.check(input)
	}

	async packageInvokeChecked(input: Record<string, unknown>) {
		const tools = await this.createPackageRuntimeInvokeTools()
		return await tools.invokeChecked(input)
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
		publishedCommit: string | null
		manifestPath: string
		sourceRoot: string
	}
	sourceFiles: Record<string, string>
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
	const kvKey = createPublishedPackageAppBundleCacheKey({
		userId: input.userId,
		source: {
			id: input.savedPackage.sourceId,
			published_commit: input.savedPackage.publishedCommit,
			manifest_path: input.savedPackage.manifestPath,
			source_root: input.savedPackage.sourceRoot,
		},
		entryPoint: appEntry,
	})
	const artifact =
		kvKey != null
			? await readPublishedBundleArtifact({
					env: input.env,
					kvKey,
				})
			: null
	const bundled =
		artifact ??
		(await (async () => {
			assertPublishedSourceCanRebuildWithoutInstallingDeps({
				sourceFiles: input.sourceFiles,
				bundleLabel: `Saved package app "${input.savedPackage.kodyId}"`,
			})
			const compiled = await buildKodyAppBundle({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceFiles: input.sourceFiles,
				entryPoint: appEntry,
				cacheKey: kvKey,
			})
			if (!input.savedPackage.publishedCommit || kvKey == null) {
				return compiled
			}
			await writePublishedBundleArtifact({
				env: input.env,
				artifact: createPublishedBundleArtifact({
					kind: 'app',
					artifactName: input.savedPackage.kodyId,
					sourceId: input.savedPackage.sourceId,
					publishedCommit: input.savedPackage.publishedCommit,
					entryPoint: appEntry,
					mainModule: compiled.mainModule,
					modules: compiled.modules,
					dependencies: compiled.dependencies,
					dynamicDependencies: compiled.dynamicDependencies,
					packageContext: {
						packageId: input.savedPackage.id,
						kodyId: input.savedPackage.kodyId,
						sourceId: input.savedPackage.sourceId,
					},
				}),
				kvKey,
			})
			return compiled
		})())
	const mainModule = 'package-app-entry.js'
	const hydratedModules = await hydrateKodyRuntimeModules({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		modules: bundled.modules,
	})
	const modules = {
		...hydratedModules,
		[mainModule]: createPackageAppWorkerSource({
			mainModule: bundled.mainModule,
		}),
	}
	return {
		// Keep the loader stub per-request because the bound runtime bridge props are
		// caller-specific (user/package context) and we do not want to risk leaking
		// request-scoped bindings through a reused stub.
		stub: input.env.APP_LOADER.load({
			compatibilityDate: '2026-04-13',
			compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
			mainModule,
			modules,
			env: {
				[packageAppRuntimeBindingName]: workerExports.PackageAppRuntimeBridge({
					props: {
						baseUrl: input.baseUrl,
						userId: input.userId,
						email: input.runtime.callerContext.user?.email ?? '',
						displayName:
							input.runtime.callerContext.user?.displayName ??
							`package:${input.savedPackage.id}`,
						packageId: input.savedPackage.id,
						kodyId: input.savedPackage.kodyId,
						sourceId: input.savedPackage.sourceId,
						publishedCommit: input.savedPackage.publishedCommit,
					},
				}),
				__kodyPackageContext: {
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					sourceId: input.savedPackage.sourceId,
					publishedCommit: input.savedPackage.publishedCommit,
				},
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
		username?: string
		displayName?: string
	}
	packageId: string
}) {
	return createMcpCallerContext({
		baseUrl: input.baseUrl,
		user: {
			userId: input.user.userId,
			email: input.user.email,
			username: input.user.username,
			displayName: input.user.displayName ?? `package:${input.packageId}`,
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			storageId: input.packageId,
		},
	})
}
