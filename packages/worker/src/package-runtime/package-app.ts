import { WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	getPackageAppEntryPath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	buildKodyFns,
	collectPackageStorageGrantIds,
	type PackageEventTools,
	type PackageInvokeTools,
} from '#mcp/run-kody-registry.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	createAuthenticatedFetch,
	refreshAccessToken,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import {
	buildKodyAppBundle,
	createPublishedPackageAppBundleCacheKey,
	hydrateKodyRuntimeModules,
} from './module-graph.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	assertStorageRunnerWriteWithinEntitlement,
	buildPackageStorageId,
	createPackageStorageAccessDeniedMessage,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import {
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageSqlWriteBytes,
} from '#worker/entitlements/service.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
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
	createExecutionSecretRedactor,
	type ExecutionSecretRedactor,
} from '#mcp/secrets/execution-secret-redactor.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordHandle,
	type RunRecordLogInput,
	type RunTerminalStatus,
} from '#worker/run-records/types.ts'

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

function createKodyProxy(runtimeBridge) {
	const remote = new Proxy({}, {
		get(_target, connectorName) {
			if (typeof connectorName !== 'string' || connectorName === 'then') {
				return undefined;
			}
			return new Proxy({}, {
				get(_connectorTarget, capabilityName) {
					if (typeof capabilityName !== 'string' || capabilityName === 'then') {
						return undefined;
					}
					return async (args = {}) =>
						await runtimeBridge.callCapability({
							name: \`remote:\${connectorName}:\${capabilityName}\`,
							args,
						});
				},
			});
		},
	});
	const mcp = new Proxy({}, {
		get(_target, serverName) {
			if (typeof serverName !== 'string' || serverName === 'then') {
				return undefined;
			}
			return new Proxy({}, {
				get(_serverTarget, toolName) {
					if (typeof toolName !== 'string' || toolName === 'then') {
						return undefined;
					}
					return async (args = {}) =>
						await runtimeBridge.callCapability({
							name: \`mcp:\${serverName}:\${toolName}\`,
							args,
						});
				},
			});
		},
	});
	return new Proxy({}, {
		get(_target, property) {
			if (typeof property !== 'string' || property === 'then') return undefined;
			if (property === 'remote') return remote;
			if (property === 'mcp') return mcp;
			if (property.startsWith('remote:')) {
				throw new Error(
					\`Remote connector capability "\${property}" is not available as a flat kody function. Use kody.remote[connectorName].capabilityName(input) instead.\`,
				);
			}
			if (property.startsWith('mcp:')) {
				throw new Error(
					\`MCP server tool "\${property}" is not available as a flat kody function. Use kody.mcp[serverName].toolName(input) instead.\`,
				);
			}
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
	const normalizeRunAt = (input) => {
		const value = input?.runAt;
		if (value === undefined || value === null || value === '') {
			return null;
		}
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
			const runAt = normalizeRunAt(input);
			const idempotencyKey = normalizeOptionalString(input, 'idempotencyKey');
			const payload = {
				...(runAt ? { runAt } : {}),
				...(idempotencyKey ? { idempotencyKey } : {}),
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

function createEventsProxy(runtimeBridge) {
	return {
		dispatch: async (input) =>
			await runtimeBridge.packageEventDispatch(input ?? {}),
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
		kody: createKodyProxy(runtimeBridge),
		storage: createStorageProxy(runtimeBridge, packageId),
		__kodyPackageStorage: (storagePackageId) => ({
			id: 'package:' + encodeURIComponent(storagePackageId),
			get: async (key) =>
				(
					await runtimeBridge.packageStorageGet({
						packageId: storagePackageId,
						key,
					})
				).value,
			list: async (options = {}) =>
				await runtimeBridge.packageStorageList({
					...options,
					packageId: storagePackageId,
				}),
			sql: async (query, params = []) =>
				await runtimeBridge.packageStorageSql({
					packageId: storagePackageId,
					query,
					params,
					writable: true,
				}),
			set: async (key, value) =>
				await runtimeBridge.packageStorageSet({
					packageId: storagePackageId,
					key,
					value,
				}),
			delete: async (key) =>
				await runtimeBridge.packageStorageDelete({
					packageId: storagePackageId,
					key,
				}),
			clear: async () =>
				await runtimeBridge.packageStorageClear({
					packageId: storagePackageId,
				}),
		}),
		refreshAccessToken: async (providerName) =>
			await runtimeBridge.refreshAccessToken(providerName),
		createAuthenticatedFetch: createAuthenticatedFetchHelper(runtimeBridge),
		realtime: createRealtimeProxy(runtimeBridge),
		services: createServicesProxy(runtimeBridge),
		packageSecrets,
		workflows: createWorkflowsProxy(runtimeBridge),
		packages: createPackagesProxy(runtimeBridge),
		events: createEventsProxy(runtimeBridge),
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

function createConsoleLogCapture() {
	const logs = [];
	const previousConsole = globalThis.console;
	const push = (level, args) => {
		logs.push({
			level,
			message: args.map((value) => String(value)).join(' '),
		});
	};
	const captureConsole = {
		...previousConsole,
		debug: (...args) => {
			push('debug', args);
			previousConsole.debug(...args);
		},
		info: (...args) => {
			push('info', args);
			previousConsole.info(...args);
		},
		log: (...args) => {
			push('log', args);
			previousConsole.log(...args);
		},
		warn: (...args) => {
			push('warn', args);
			previousConsole.warn(...args);
		},
		error: (...args) => {
			push('error', args);
			previousConsole.error(...args);
		},
	};
	return {
		logs,
		install() {
			globalThis.console = captureConsole;
		},
		restore() {
			globalThis.console = previousConsole;
		},
	};
}

async function startRuntimeRun(runtimeBridge, input) {
	return await runtimeBridge.packageRuntimeRunStart(input);
}

function finishRuntimeRun(runtimeBridge, executionCtx, input) {
	executionCtx.waitUntil(runtimeBridge.packageRuntimeRunFinish(input));
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
		const consoleCapture = createConsoleLogCapture();
		const runtime = createRuntime(
			runtimeBridge,
			this.env.__kodyPackageContext ?? null,
		);
		try {
			consoleCapture.install();
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
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'success',
				logs: consoleCapture.logs,
			});
			return response;
		} catch (error) {
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'error',
				error: serializeRuntimeError(error),
				logs: consoleCapture.logs,
			});
			throw error;
		} finally {
			consoleCapture.restore();
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
		const consoleCapture = createConsoleLogCapture();
		const runtime = createRuntime(
			runtimeBridge,
			this.env.__kodyPackageContext ?? null,
		);
		try {
			consoleCapture.install();
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
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'success',
				logs: consoleCapture.logs,
			});
			return result;
		} catch (error) {
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'error',
				error: serializeRuntimeError(error),
				logs: consoleCapture.logs,
			});
			throw error;
		} finally {
			consoleCapture.restore();
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
	packageStorageGrantIds: Array<string>
}

function redactRunRecordLogs(
	logs: Array<RunRecordLogInput> | undefined,
	secretRedactor: ExecutionSecretRedactor,
): Array<RunRecordLogInput> | undefined {
	if (!logs) return logs
	return logs.map((entry) => {
		if (typeof entry === 'string') {
			return secretRedactor.redactErrorMessage(entry)
		}
		return {
			...entry,
			message: secretRedactor.redactErrorMessage(entry.message),
		}
	})
}

function redactRunRecordError(
	error: unknown,
	secretRedactor: ExecutionSecretRedactor,
): unknown {
	if (error === undefined) return undefined
	return secretRedactor.redactUnknown(error)
}

export class PackageAppRuntimeBridge extends WorkerEntrypoint<
	Env,
	PackageAppRuntimeBridgeProps
> {
	private packageRuntimeInvokeTools: Promise<PackageInvokeTools> | null = null
	private packageEventTools: Promise<PackageEventTools> | null = null
	private readonly secretRedactor: ExecutionSecretRedactor =
		createExecutionSecretRedactor()

	private createCallerContext(storageId: string | null) {
		return createMcpCallerContext({
			baseUrl: this.ctx.props.baseUrl,
			executionOrigin: 'background',
			user: {
				userId: this.ctx.props.userId,
				email: this.ctx.props.email,
				username: undefined,
				displayName: this.ctx.props.displayName,
			},
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.packageId,
				packageId: this.ctx.props.packageId,
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

	private async assertStorageWriteAllowed(input: {
		storageId: string
		requested?: number
	}) {
		await assertStorageRunnerWriteWithinEntitlement({
			env: this.env,
			userId: this.ctx.props.userId,
			email: this.ctx.props.email,
			storageId: input.storageId,
			requested: input.requested,
		})
	}

	/**
	 * Security model for package-app storage:
	 * - Raw `storage*` methods are namespace-locked to this app's own buckets
	 *   (`packageId` and `${packageId}:…`). The bridge stub is reachable from
	 *   user code via `Object.create(env)`, so these methods must never accept
	 *   arbitrary same-user ids (`package:…`, `job:…`, other package roots).
	 * - `package:{…}` durable buckets are reached only through the
	 *   grant-validated `packageStorage*` methods (`assertPackageStorageGranted`
	 *   from bundler-controlled provenance).
	 */
	private assertAppOwnedStorageId(storageId: string) {
		const normalizedStorageId = storageId.trim()
		if (!normalizedStorageId) {
			throw new Error('Package app storage requires a non-empty storage id.')
		}
		const packageId = this.ctx.props.packageId
		if (
			normalizedStorageId === packageId ||
			normalizedStorageId.startsWith(`${packageId}:`)
		) {
			return normalizedStorageId
		}
		throw new Error(
			`Package app storage id "${normalizedStorageId}" is outside this app's namespace. ` +
				`Raw storage methods only accept "${packageId}" or ids prefixed with "${packageId}:". ` +
				'Saved-package durable buckets use packageStorage() and are gated by bundler provenance grants.',
		)
	}

	private assertPackageStorageGranted(packageId: string) {
		const normalizedPackageId = packageId.trim()
		if (!normalizedPackageId) {
			throw new Error('packageStorage requires a non-empty package id.')
		}
		const grantedPackageIds = new Set(this.ctx.props.packageStorageGrantIds)
		if (!grantedPackageIds.has(normalizedPackageId)) {
			throw new Error(
				createPackageStorageAccessDeniedMessage(normalizedPackageId),
			)
		}
		return normalizedPackageId
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
	}): Promise<RunRecordHandle | null> {
		return beginRunRecord({
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
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise)
			},
		})
	}

	async packageRuntimeRunFinish(input: {
		run: RunRecordHandle | null
		status: RunTerminalStatus
		error?: unknown
		logs?: Array<RunRecordLogInput>
	}) {
		const logs = redactRunRecordLogs(input.logs, this.secretRedactor)
		const error = redactRunRecordError(input.error, this.secretRedactor)
		const finishPromise = finishRunRecord({
			env: this.env,
			handle: input.run,
			status: input.status,
			error,
			logs,
		}).catch((finishError: unknown) => {
			console.warn('package-app-run-record-finish-failed', finishError)
		})
		this.ctx.waitUntil(finishPromise)
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
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).getValue({
			key: input.key,
		})
	}

	async storageList(input: {
		storageId: string
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).listValues({
			prefix: input.prefix,
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	private async sqlQueryWithEntitlement(input: {
		storageId: string
		query: string
		params?: Array<unknown>
		writable: boolean
	}) {
		if (input.writable) {
			await this.assertStorageWriteAllowed({
				storageId: input.storageId,
				requested: estimateEntitlementStorageSqlWriteBytes({
					query: input.query,
					params: input.params,
				}),
			})
		}
		return await this.getStorageRunner(input.storageId).sqlQuery({
			query: input.query,
			params: input.params,
			writable: input.writable,
		})
	}

	private async setValueWithEntitlement(input: {
		storageId: string
		key: string
		value: unknown
	}) {
		const existing = await this.getStorageRunner(input.storageId).getValue({
			key: input.key,
		})
		await this.assertStorageWriteAllowed({
			storageId: input.storageId,
			requested: estimateEntitlementStorageEntryByteDelta({
				next: {
					key: input.key,
					value: input.value,
				},
				existing:
					existing.value === null
						? null
						: {
								key: input.key,
								value: existing.value,
							},
			}),
		})
		return await this.getStorageRunner(input.storageId).setValue({
			key: input.key,
			value: input.value,
		})
	}

	async storageSql(input: {
		storageId: string
		query: string
		params?: Array<unknown>
		writable?: boolean
	}) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.sqlQueryWithEntitlement({
			storageId,
			query: input.query,
			params: input.params,
			writable: input.writable ?? false,
		})
	}

	async storageSet(input: { storageId: string; key: string; value: unknown }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.setValueWithEntitlement({
			storageId,
			key: input.key,
			value: input.value,
		})
	}

	async storageDelete(input: { storageId: string; key: string }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).deleteValue({
			key: input.key,
		})
	}

	async storageClear(input: { storageId: string }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).clearStorage()
	}

	async packageStorageGet(input: { packageId: string; key: string }) {
		const packageId = this.assertPackageStorageGranted(input.packageId)
		// Provenance-granted package: buckets intentionally bypass the app
		// namespace lock on raw storage* (assertAppOwnedStorageId).
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
		).getValue({
			key: input.key,
		})
	}

	async packageStorageList(input: {
		packageId: string
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		const packageId = this.assertPackageStorageGranted(input.packageId)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
		).listValues({
			prefix: input.prefix,
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	async packageStorageSql(input: {
		packageId: string
		query: string
		params?: Array<unknown>
		writable?: boolean
	}) {
		const packageId = this.assertPackageStorageGranted(input.packageId)
		return await this.sqlQueryWithEntitlement({
			storageId: buildPackageStorageId(packageId),
			query: input.query,
			params: input.params,
			writable: input.writable ?? false,
		})
	}

	async packageStorageSet(input: {
		packageId: string
		key: string
		value: unknown
	}) {
		const packageId = this.assertPackageStorageGranted(input.packageId)
		return await this.setValueWithEntitlement({
			storageId: buildPackageStorageId(packageId),
			key: input.key,
			value: input.value,
		})
	}

	async packageStorageDelete(input: { packageId: string; key: string }) {
		const packageId = this.assertPackageStorageGranted(input.packageId)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
		).deleteValue({
			key: input.key,
		})
	}

	async packageStorageClear(input: { packageId: string }) {
		const packageId = this.assertPackageStorageGranted(input.packageId)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
		).clearStorage()
	}

	async refreshAccessToken(providerName: string) {
		const kody = await buildKodyFns(
			this.env,
			this.createCallerContext(this.ctx.props.packageId),
		)
		return await refreshAccessToken(kody, providerName)
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
		const kody = await buildKodyFns(
			this.env,
			this.createCallerContext(this.ctx.props.packageId),
		)
		const authenticatedFetch = await createAuthenticatedFetch(
			kody,
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
		this.secretRedactor.track(resolved.value)
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
			userEmail: this.ctx.props.email,
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
						parentRunRecord: null,
						packageInvokeDepth: 0,
					})
				},
			)
		return await this.packageRuntimeInvokeTools
	}

	async createPackageEventTools() {
		if (this.packageEventTools) return await this.packageEventTools

		// Avoid a top-level package-app -> package-invocations cycle during worker
		// startup; apps only need this helper when package code calls it.
		this.packageEventTools =
			import('#worker/package-invocations/service.ts').then(
				({ createPackageEventTools }) => {
					const packageContext = {
						packageId: this.ctx.props.packageId,
						kodyId: this.ctx.props.kodyId,
						sourceId: this.ctx.props.sourceId,
					}
					return createPackageEventTools({
						env: this.env,
						baseUrl: this.ctx.props.baseUrl,
						callerContext: this.createCallerContext(this.ctx.props.packageId),
						packageContext,
						parentRunRecord: null,
						packageInvokeDepth: 0,
					})
				},
			)
		return await this.packageEventTools
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

	async packageEventDispatch(input: Record<string, unknown>) {
		const tools = await this.createPackageEventTools()
		return await tools.dispatch(input)
	}
}

type PackageAppWorkerOptions = Parameters<Env['APP_LOADER']['load']>[0]

type PackageAppWorkerBuild = {
	workerId: string | null
	workerOptions: PackageAppWorkerOptions
}

// Caches the built worker options (bundle lookup + hydration + wrapper), not
// loader stubs: worker-loader stubs are bound to the request that created them
// and must be re-acquired per request via APP_LOADER.get/load.
const packageAppWorkerOptionsCache =
	new PromiseLruCache<PackageAppWorkerBuild>()

export async function createPackageAppWorkerId(input: {
	cacheKey: string
	workerOptions: PackageAppWorkerOptions
}) {
	const moduleEntries = Object.entries(input.workerOptions.modules ?? {})
	if (
		moduleEntries.some(([, moduleValue]) => typeof moduleValue !== 'string')
	) {
		// Non-string modules cannot be hashed deterministically; fall back to
		// one-off loads for those workers.
		return null
	}
	const sortedModuleEntries = [...moduleEntries].sort(([left], [right]) =>
		left.localeCompare(right),
	)
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			JSON.stringify([
				'package-app-worker@v1',
				input.cacheKey,
				input.workerOptions.compatibilityDate ?? null,
				input.workerOptions.compatibilityFlags ?? [],
				input.workerOptions.mainModule,
				sortedModuleEntries,
			]),
		),
	)
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
	return `package-app-${hash.slice(0, 43)}`
}

function createPackageAppWorkerCacheKey(input: {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
	baseUrl: string
	callerEmail: string
	callerDisplayName: string
}) {
	if (!input.publishedCommit) {
		return null
	}
	return JSON.stringify([
		input.userId,
		input.packageId,
		input.kodyId,
		input.sourceId,
		input.publishedCommit,
		input.baseUrl,
		input.callerEmail,
		input.callerDisplayName,
	])
}

function resolvePackageAppManifest(input: {
	manifest?: AuthoredPackageJson
	source?: EntitySourceRow
	sourceFiles?: Record<string, string>
	savedPackage: {
		manifestPath: string
	}
}) {
	if (input.manifest) {
		return input.manifest
	}
	const packageJsonContent = input.sourceFiles?.['package.json']
	if (!packageJsonContent) {
		throw new Error('Saved package is missing package.json.')
	}
	return parseAuthoredPackageJson({
		content: packageJsonContent,
		manifestPath:
			input.source?.manifest_path ?? input.savedPackage.manifestPath,
	})
}

async function resolvePersistablePackageSource(input: {
	env: Env
	userId: string
	source?: EntitySourceRow
	sourceId: string
}) {
	if (input.source?.user_id === input.userId && input.source.repo_id) {
		return input.source
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Saved package source "${input.sourceId}" was not found.`)
	}
	return source
}

async function resolvePackageAppBundledArtifact(input: {
	env: Env
	userId: string
	source?: EntitySourceRow
	manifest: AuthoredPackageJson
	savedPackage: {
		id: string
		kodyId: string
		sourceId: string
		publishedCommit: string | null
		manifestPath: string
		sourceRoot: string
	}
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
	baseUrl: string
}) {
	const appEntry = getPackageAppEntryPath(input.manifest)
	if (!appEntry) {
		throw new Error(
			`Saved package "${input.savedPackage.kodyId}" does not define kody.app.entry.`,
		)
	}
	const sourceForCache = input.source ?? {
		id: input.savedPackage.sourceId,
		published_commit: input.savedPackage.publishedCommit,
		manifest_path: input.savedPackage.manifestPath,
		source_root: input.savedPackage.sourceRoot,
	}
	const inMemoryCacheKey = createPublishedPackageAppBundleCacheKey({
		userId: input.userId,
		source: sourceForCache,
		entryPoint: appEntry,
	})
	if (!input.savedPackage.publishedCommit) {
		const sourceFiles = await resolvePackageAppSourceFiles(input)
		assertPublishedSourceCanRebuildWithoutInstallingDeps({
			sourceFiles,
			bundleLabel: `Saved package app "${input.savedPackage.kodyId}"`,
		})
		return await buildKodyAppBundle({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles,
			entryPoint: appEntry,
			rootPackageId: input.savedPackage.id,
			cacheKey: inMemoryCacheKey,
		})
	}
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'app',
		artifactName: null,
		entryPoint: appEntry,
	})
	if (loadedArtifact?.artifact) {
		return {
			mainModule: loadedArtifact.artifact.mainModule,
			modules: loadedArtifact.artifact.modules,
			dependencies: loadedArtifact.artifact.dependencies,
			dynamicDependencies: loadedArtifact.artifact.dynamicDependencies,
		}
	}
	const sourceFiles = await resolvePackageAppSourceFiles(input)
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles,
		bundleLabel: `Saved package app "${input.savedPackage.kodyId}"`,
	})
	const compiled = await buildKodyAppBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles,
		entryPoint: appEntry,
		rootPackageId: input.savedPackage.id,
		cacheKey: inMemoryCacheKey,
	})
	const persistableSource = await resolvePersistablePackageSource({
		env: input.env,
		userId: input.userId,
		source: input.source,
		sourceId: input.savedPackage.sourceId,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: persistableSource,
		kind: 'app',
		artifactName: null,
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
	})
	return compiled
}

async function resolvePackageAppSourceFiles(input: {
	sourceFiles?: Record<string, string>
	loadSourceFiles?: () => Promise<Record<string, string>>
}) {
	if (input.sourceFiles) {
		return input.sourceFiles
	}
	if (!input.loadSourceFiles) {
		throw new Error(
			'Saved package source files are required to rebuild the app.',
		)
	}
	return await input.loadSourceFiles()
}

async function buildPackageAppWorkerOptionsUncached(input: {
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
	source?: EntitySourceRow
	manifest?: AuthoredPackageJson
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
	runtime: {
		callerContext: ReturnType<typeof createMcpCallerContext>
	}
}): Promise<PackageAppWorkerOptions> {
	const manifest = resolvePackageAppManifest({
		manifest: input.manifest,
		source: input.source,
		sourceFiles: input.sourceFiles,
		savedPackage: input.savedPackage,
	})
	const bundled = await resolvePackageAppBundledArtifact({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		source: input.source,
		manifest,
		savedPackage: input.savedPackage,
		loadSourceFiles: input.loadSourceFiles,
		sourceFiles: input.sourceFiles,
	})
	const mainModule = 'package-app-entry.js'
	const { modules: hydratedModules, dynamicDependencyPackageIds } =
		await hydrateKodyRuntimeModules({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			modules: bundled.modules,
		})
	const packageStorageGrantIds = [
		...collectPackageStorageGrantIds({
			packageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
			},
			dependencies: bundled.dependencies,
			dynamicDependencyPackageIds,
		}),
	]
	const modules = {
		...hydratedModules,
		[mainModule]: createPackageAppWorkerSource({
			mainModule: bundled.mainModule,
		}),
	}
	return {
		...createDynamicWorkerCompatibilityOptions(),
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
					packageStorageGrantIds,
				},
			}),
			__kodyPackageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
				publishedCommit: input.savedPackage.publishedCommit,
			},
		},
		globalOutbound: workerExports?.KodyFetchGateway
			? workerExports.KodyFetchGateway({
					props: {
						baseUrl: input.baseUrl,
						userId: input.userId,
						email: input.runtime.callerContext.user?.email ?? null,
						storageContext: {
							sessionId: null,
							appId: input.savedPackage.id,
							packageId: input.savedPackage.id,
							storageId: input.savedPackage.id,
						},
					},
				})
			: null,
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
	source?: EntitySourceRow
	manifest?: AuthoredPackageJson
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
	runtime: {
		callerContext: ReturnType<typeof createMcpCallerContext>
	}
}) {
	const cacheKey = createPackageAppWorkerCacheKey({
		userId: input.userId,
		packageId: input.savedPackage.id,
		kodyId: input.savedPackage.kodyId,
		sourceId: input.savedPackage.sourceId,
		publishedCommit: input.savedPackage.publishedCommit,
		baseUrl: input.baseUrl,
		callerEmail: input.runtime.callerContext.user?.email ?? '',
		callerDisplayName:
			input.runtime.callerContext.user?.displayName ??
			`package:${input.savedPackage.id}`,
	})
	if (!cacheKey) {
		return {
			stub: input.env.APP_LOADER.load(
				await buildPackageAppWorkerOptionsUncached(input),
			),
			entrypointName: packageAppEntrypointName,
		}
	}
	const build = await packageAppWorkerOptionsCache.getOrCreate({
		cacheKey,
		create: async () => {
			const workerOptions = await buildPackageAppWorkerOptionsUncached(input)
			return {
				workerId: await createPackageAppWorkerId({ cacheKey, workerOptions }),
				workerOptions,
			}
		},
	})
	return {
		// Stubs are request-bound, so acquire a fresh one per request. The stable
		// worker id (derived from user + package + commit + caller identity) lets
		// the loader reuse a warm isolate instead of compiling a new worker.
		stub: build.workerId
			? input.env.APP_LOADER.get(build.workerId, () => build.workerOptions)
			: input.env.APP_LOADER.load(build.workerOptions),
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
		executionOrigin: 'background',
		user: {
			userId: input.user.userId,
			email: input.user.email,
			username: input.user.username,
			displayName: input.user.displayName ?? `package:${input.packageId}`,
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			packageId: input.packageId,
			storageId: input.packageId,
		},
	})
}
