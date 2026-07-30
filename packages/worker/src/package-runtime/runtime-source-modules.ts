import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
import {
	decodePathKey,
	dirname,
	dynamicPackageImportResolvedMarker,
	encodePathKey,
	joinPath,
	normalizeWorkspaceModulePath,
	packageRuntimeModulePrefix,
	resolveRelativeModulePath,
	runtimeModulePath,
} from './module-graph-paths.ts'

let cachedRuntimeModuleSource: string | null = null

export function createRuntimeModuleSource() {
	if (cachedRuntimeModuleSource) {
		return cachedRuntimeModuleSource
	}
	// The runtime context for a single execute-call / package-app fetch is
	// kept in AsyncLocalStorage rather than a single mutable globalThis slot.
	// AsyncLocalStorage propagates through async chains so concurrent calls
	// in the same isolate cannot clobber each other's runtime view, and the
	// surrounding wrapper no longer needs a try/finally save/restore dance.
	//
	// The AsyncLocalStorage *instance* must be shared between this virtual
	// runtime module and the surrounding execute / package-app wrapper,
	// because the wrapper is the one that calls `.run(runtime, cb)` while
	// user code reads the resulting store via the exports below. We share
	// the instance through a globalThis symbol; only the *instance* lives on
	// globalThis - the per-request runtime value is held inside the ALS, so
	// concurrent requests do not stomp on each other's view.
	//
	// This module is evaluated at most once per isolate, but dynamic workers
	// with identical code are cached and reused across executions (stable
	// worker-loader ids). Per-run values must therefore never freeze into
	// module scope: the \`kody\` capability proxy in particular closes over
	// the RPC ToolDispatcher stubs passed to a single \`evaluate()\` call,
	// and those stubs are implicitly disposed when that call returns. A
	// frozen \`export const kody = runtime.kody\` would make every later run
	// in a reused worker call capabilities through the first run's disposed
	// stubs ("RPC stub used after being disposed"). Every export below is
	// instead late-bound: it re-reads the current AsyncLocalStorage store on
	// each property access / call.
	//
	// Optional helpers (\`storage\`, \`email\`, ...) still preserve their
	// absent value (\`undefined\` / \`null\`) so \`if (email) { ... }\`
	// guards stay falsy when a wrapper intentionally omits that export.
	// Helper *presence* is decided by the generated wrapper source, which is
	// part of the worker id hash, so presence observed on the first in-run
	// evaluation is identical for every later run of the same worker.
	//
	// \`kody\` is always exported as a late-bound proxy: every
	// execute/package runtime provides it, and Worker module loaders may
	// evaluate this virtual module before the wrapper installs the per-run
	// store. The proxy resolves against the current AsyncLocalStorage store
	// at call time in both the preload and the reused-worker case.
	const source = `
import { AsyncLocalStorage } from 'node:async_hooks';

const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __globalAny = /** @type {any} */ (globalThis);
const __kodyRuntimeStorage =
	__globalAny[__kodyRuntimeStorageSymbol] ??
	(__globalAny[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());

export function __kodyRunInRuntime(runtime, callback) {
	return __kodyRuntimeStorage.run(runtime, callback);
}

function __kodyReadRuntimeExport(exportName) {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const runtimeExport = currentRuntime?.[exportName];
	if (runtimeExport == null) {
		throw new Error(
			\`kody:runtime export "\${exportName}" is not available in this execution context.\`,
		);
	}
	return runtimeExport;
}

function __kodyRuntimeProxyLabel(exportName) {
	return \`[KodyRuntime:\${exportName}]\`;
}

function __kodyRuntimeProxyInspectionValue(exportName, property) {
	if (property === Symbol.toStringTag) return \`KodyRuntime:\${exportName}\`;
	if (property === 'then') return undefined;
	if (
		property === Symbol.iterator ||
		property === Symbol.asyncIterator
	) {
		return undefined;
	}
	if (
		property === Symbol.toPrimitive ||
		property === Symbol.for('nodejs.util.inspect.custom') ||
		property === 'inspect' ||
		property === 'toString'
	) {
		return () => __kodyRuntimeProxyLabel(exportName);
	}
	if (property === 'valueOf') {
		return () => __kodyCreateRuntimeObjectProxy(exportName);
	}
	return undefined;
}

function __kodyIsRuntimeProxyInspectionProperty(property) {
	return (
		property === Symbol.toStringTag ||
		property === 'then' ||
		property === Symbol.iterator ||
		property === Symbol.asyncIterator ||
		property === Symbol.toPrimitive ||
		property === Symbol.for('nodejs.util.inspect.custom') ||
		property === 'inspect' ||
		property === 'toString' ||
		property === 'valueOf'
	);
}

function __kodyCreateRuntimeObjectProxy(exportName) {
	return new Proxy({}, {
		get(_target, property) {
			const inspectionValue = __kodyRuntimeProxyInspectionValue(
				exportName,
				property,
			);
			if (inspectionValue !== undefined || __kodyIsRuntimeProxyInspectionProperty(property)) {
				return inspectionValue;
			}
			const runtimeExport = __kodyReadRuntimeExport(exportName);
			const value = runtimeExport[property];
			if (typeof value !== 'function') return value;
			// Late-bind method calls to the runtime of the *calling* run: a
			// function captured at property-access time (for example a
			// top-level \`const search = kody.community_search\`) would
			// otherwise keep pointing at the run that evaluated this module,
			// whose RPC dispatcher stubs are disposed once that run returns.
			return function (...args) {
				const currentExport = __kodyReadRuntimeExport(exportName);
				const currentValue = currentExport[property];
				if (typeof currentValue !== 'function') {
					throw new Error(
						\`kody:runtime export "\${exportName}.\${String(property)}" is not callable in this execution context.\`,
					);
				}
				return currentValue.apply(currentExport, args);
			};
		},
		has(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return false;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			return runtimeExport != null && property in runtimeExport;
		},
		ownKeys() {
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			return runtimeExport == null ? [] : Reflect.ownKeys(runtimeExport);
		},
		getOwnPropertyDescriptor(_target, property) {
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			if (runtimeExport == null) return undefined;
			const descriptor = Reflect.getOwnPropertyDescriptor(runtimeExport, property);
			if (descriptor === undefined) return undefined;
			return { ...descriptor, configurable: true };
		},
	});
}

function __kodyCreateRuntimeFunctionExport(exportName) {
	return function (...args) {
		const runtimeExport = __kodyReadRuntimeExport(exportName);
		if (typeof runtimeExport !== 'function') {
			throw new Error(
				\`kody:runtime export "\${exportName}" is not callable in this execution context.\`,
			);
		}
		return runtimeExport(...args);
	};
}

const __kodyInitialRuntime = __kodyRuntimeStorage.getStore();

function __kodyOptionalRuntimeObjectExport(exportName, absentValue) {
	if (__kodyInitialRuntime === undefined) return absentValue;
	if (__kodyInitialRuntime[exportName] == null) return absentValue;
	return __kodyCreateRuntimeObjectProxy(exportName);
}

function __kodyOptionalRuntimeFunctionExport(exportName) {
	if (__kodyInitialRuntime === undefined) return undefined;
	if (typeof __kodyInitialRuntime[exportName] !== 'function') return undefined;
	return __kodyCreateRuntimeFunctionExport(exportName);
}

function __kodyResolvePackageStorage(packageId) {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const factory = currentRuntime?.__kodyPackageStorage;
	if (typeof factory !== 'function') {
		throw new Error(
			'packageStorage() is not available in this execution context. It is bound for bundled module runs (execute calls and saved-package invocations) with an authenticated user.',
		);
	}
	return factory(packageId);
}

// Factory for the bundler's per-package virtual runtime modules: each module
// that originates from a saved package imports 'kody:runtime' through a
// module whose packageStorage closes over that package's immutable id (see
// createPackageRuntimeModuleSource). The closure survives bundler inlining,
// and the host independently validates the id against the run's provenance
// grants, so this stamp routes identity without being a security boundary.
export function __kodyCreatePackageBoundStorage(packageId) {
	return function packageStorage() {
		return __kodyResolvePackageStorage(packageId);
	};
}

function __kodyRecordStaticPackageCall(packageId, startedAtMs, outcome) {
	// Metering must never block or throw into the call path: reporting is a
	// synchronous buffer push into the current run's meter (the surrounding
	// wrapper flushes the buffer over the host bridge once, at the end of
	// the run, while its RPC dispatchers are still live). The meter is read
	// late-bound from the run store so reused worker isolates never pin a
	// previous run's state, and runs without a meter simply skip recording.
	try {
		const meter = __kodyRuntimeStorage.getStore()?.__kodyStaticCallMeter;
		if (meter == null || typeof meter.report !== 'function') return;
		meter.report({
			packageId,
			durationMs: Date.now() - startedAtMs,
			outcome,
		});
	} catch {}
}

// Call-metering wrapper for statically imported package exports. The
// bundler stamps the callee package id into generated import proxies (see
// createMeteredPackageImportProxySource); the id is identity routing only —
// the host independently validates it against the run's bundler-recorded
// dependency provenance before recording anything. Non-function exports
// pass through unchanged; function exports keep their identity semantics
// (arguments, this, return values, thrown errors, properties, construct)
// behind a transparent Proxy whose only addition is a non-blocking usage
// event per call. Only [[Call]] is trapped: every other internal method,
// including [[Construct]], forwards to the target per the Proxy spec, so
// \`new WrappedClass()\` constructs the real class (construction is not
// metered).
export function __kodyMeterStaticPackageExport(packageId, exportValue) {
	if (typeof exportValue !== 'function') return exportValue;
	return new Proxy(exportValue, {
		apply(target, thisArg, argumentsList) {
			const startedAtMs = Date.now();
			let result;
			try {
				result = Reflect.apply(target, thisArg, argumentsList);
			} catch (error) {
				__kodyRecordStaticPackageCall(packageId, startedAtMs, 'error');
				throw error;
			}
			// Deliberately only native promises: subscribing to an arbitrary
			// user thenable would invoke its then() from the metering path,
			// which can trigger lazy side effects (query-builder style
			// thenables execute when first awaited) — a behavior change the
			// wrapper must never cause. All modules run in one isolate, so
			// async exports always return same-realm native promises;
			// non-promise thenables record at return time instead of
			// settlement.
			if (result instanceof Promise) {
				result.then(
					() => __kodyRecordStaticPackageCall(packageId, startedAtMs, 'success'),
					() => __kodyRecordStaticPackageCall(packageId, startedAtMs, 'error'),
				);
				return result;
			}
			__kodyRecordStaticPackageCall(packageId, startedAtMs, 'success');
			return result;
		},
	});
}

// Unstamped fallback: modules without bundler-recorded package provenance
// (ad hoc execute code, artifacts published before stamping existed) can only
// reach the storage of the package the run itself belongs to.
export function packageStorage() {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const declaringPackageId = currentRuntime?.packageContext?.packageId;
	if (typeof declaringPackageId !== 'string' || declaringPackageId === '') {
		throw new Error(
			'packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. ' +
				'For ad hoc execute code, bind a storageId to the execute call and use the ambient storage helper, ' +
				"statically import the owning package's export (kody:@scope/package/export) when the package name is known, " +
				"or call the owning package's export via keyless packages.invoke({ kodyId, exportName, params }).",
		);
	}
	return __kodyResolvePackageStorage(declaringPackageId);
}

// \`kody\` keeps its preload late-binding (imported before any store exists)
// and additionally stays late-bound for in-run evaluations, so reused worker
// isolates never pin the first run's dispatcher-backed proxy. A wrapper that
// deliberately omits \`kody\` still observes \`undefined\` so falsiness
// guards keep working.
export const kody =
	__kodyInitialRuntime === undefined || __kodyInitialRuntime.kody != null
		? __kodyCreateRuntimeObjectProxy('kody')
		: undefined;
export const storage = __kodyOptionalRuntimeObjectExport('storage', undefined);
export const refreshAccessToken = __kodyOptionalRuntimeFunctionExport('refreshAccessToken');
export const createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport('createAuthenticatedFetch');
export const secretHeaders = __kodyOptionalRuntimeObjectExport('secretHeaders', undefined);
export const oauthClientCredentials = __kodyOptionalRuntimeFunctionExport('oauthClientCredentials');
export const packageContext = __kodyInitialRuntime?.packageContext ?? null;
export const serviceContext = __kodyInitialRuntime?.serviceContext ?? null;
export const service = __kodyOptionalRuntimeObjectExport('service', null);
export const packageSecrets = __kodyOptionalRuntimeObjectExport('packageSecrets', null);
export const email = __kodyOptionalRuntimeObjectExport('email', null);
export const workflows = __kodyOptionalRuntimeObjectExport('workflows', null);
export const packages = __kodyOptionalRuntimeObjectExport('packages', null);
export const events = __kodyOptionalRuntimeObjectExport('events', null);

const __kodyRuntimeNamedExports = {
	kody,
	storage,
	packageStorage,
	refreshAccessToken,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	serviceContext,
	service,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
};

// The default export mirrors the named exports and forwards any extra
// wrapper-specific helpers (for example package-app \`realtime\`) to the
// current run's store instead of freezing the first run's object.
export default new Proxy(__kodyRuntimeNamedExports, {
	get(target, property) {
		if (Reflect.has(target, property)) return Reflect.get(target, property);
		const currentRuntime = __kodyRuntimeStorage.getStore();
		return currentRuntime?.[property];
	},
	has(target, property) {
		if (Reflect.has(target, property)) return true;
		const currentRuntime = __kodyRuntimeStorage.getStore();
		return currentRuntime != null && property in currentRuntime;
	},
	ownKeys(target) {
		const keys = new Set(Reflect.ownKeys(target));
		const currentRuntime = __kodyRuntimeStorage.getStore();
		if (currentRuntime != null) {
			for (const key of Reflect.ownKeys(currentRuntime)) keys.add(key);
		}
		return [...keys];
	},
	getOwnPropertyDescriptor(target, property) {
		const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
		if (ownDescriptor) return ownDescriptor;
		const currentRuntime = __kodyRuntimeStorage.getStore();
		if (currentRuntime == null) return undefined;
		const descriptor = Reflect.getOwnPropertyDescriptor(currentRuntime, property);
		if (descriptor === undefined) return undefined;
		return { ...descriptor, configurable: true };
	},
});
`.trim()
	cachedRuntimeModuleSource = source
	return source
}

export function isKodyRuntimeModulePath(modulePath: string) {
	return (
		modulePath === runtimeModulePath ||
		modulePath.endsWith(`/${runtimeModulePath}`)
	)
}

export function buildPackageRuntimeModulePath(packageId: string) {
	// Hex-encode the id so arbitrary saved-package ids stay path-safe and the
	// id survives a lossless round trip through the module path.
	return `${packageRuntimeModulePrefix}/${encodePathKey(packageId)}.js`
}

/**
 * Reads the stamped saved-package id back out of a per-package virtual
 * runtime module path (`.__kody_virtual__/package-runtime/<hex>.js`,
 * optionally nested under a graph or artifact prefix). Returns null for
 * every other path.
 */
export function parsePackageRuntimeModulePathPackageId(modulePath: string) {
	const normalizedPath = normalizeWorkspaceModulePath(modulePath)
	const prefix = `${packageRuntimeModulePrefix}/`
	const isPackageRuntimePath =
		normalizedPath.startsWith(prefix) || normalizedPath.includes(`/${prefix}`)
	if (!isPackageRuntimePath) return null
	const fileName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
	if (!fileName.endsWith('.js')) return null
	return decodePathKey(fileName.slice(0, -'.js'.length))
}

/**
 * Virtual runtime module for one saved package: re-exports the shared
 * runtime and overrides `packageStorage` with a variant bound to the
 * package's immutable id. The bundler rewrites `kody:runtime` imports in
 * modules that originate from that package to this module, so
 * `packageStorage()` keeps resolving to the declaring package's bucket even
 * when the module is statically imported into a foreign execution context.
 * The id baked in here is identity routing only; the host grants access from
 * its own provenance metadata (see `createPackageStorageKodyTools`).
 */
export function createPackageRuntimeModuleSource(packageId: string) {
	// Per-package modules sit one directory below the shared runtime module
	// (`.__kody_virtual__/package-runtime/<hex>.js` next to
	// `.__kody_virtual__/runtime.js`), in every graph or artifact prefix.
	const baseRuntimeSpecifier = '../runtime.js'
	return `
export * from ${JSON.stringify(baseRuntimeSpecifier)};
import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundStorage } from ${JSON.stringify(
		baseRuntimeSpecifier,
	)};
export const packageStorage = __kodyCreatePackageBoundStorage(${JSON.stringify(
		packageId,
	)});
// The default export mirrors the shared runtime default but resolves
// packageStorage to this package's bound variant.
export default new Proxy(__kodyBaseRuntimeDefault, {
	get(target, property, receiver) {
		if (property === 'packageStorage') return packageStorage;
		return Reflect.get(target, property, receiver);
	},
	has(target, property) {
		return property === 'packageStorage' || Reflect.has(target, property);
	},
});
`.trim()
}

function collectReferencedRuntimeModulePaths(
	modules: WorkerLoaderModules,
	options?: {
		includeDefaultRuntimePath?: boolean
	},
) {
	const runtimePaths = new Set<string>(
		options?.includeDefaultRuntimePath === false ? [] : [runtimeModulePath],
	)
	for (const modulePath of Object.keys(modules)) {
		if (isKodyRuntimeModulePath(modulePath)) {
			runtimePaths.add(modulePath)
		}
	}
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			const resolvedPath = resolveRelativeModulePath(modulePath, node.specifier)
			if (resolvedPath && isKodyRuntimeModulePath(resolvedPath)) {
				runtimePaths.add(resolvedPath)
			}
		}
	}
	return runtimePaths
}

function collectReferencedPackageRuntimeModulePaths(
	modules: WorkerLoaderModules,
) {
	const packageRuntimePaths = new Map<string, string>()
	const remember = (modulePath: string) => {
		const packageId = parsePackageRuntimeModulePathPackageId(modulePath)
		if (packageId != null) {
			packageRuntimePaths.set(
				normalizeWorkspaceModulePath(modulePath),
				packageId,
			)
		}
	}
	for (const modulePath of Object.keys(modules)) {
		remember(modulePath)
	}
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			const resolvedPath = resolveRelativeModulePath(modulePath, node.specifier)
			if (resolvedPath) {
				remember(resolvedPath)
			}
		}
	}
	return packageRuntimePaths
}

export function refreshKodyRuntimeModules(
	modules: WorkerLoaderModules,
	options?: {
		includeDefaultRuntimePath?: boolean
	},
): WorkerLoaderModules {
	const refreshed: WorkerLoaderModules = { ...modules }
	for (const modulePath of collectReferencedRuntimeModulePaths(
		modules,
		options,
	)) {
		refreshed[modulePath] = createRuntimeModuleSource()
	}
	for (const [
		modulePath,
		packageId,
	] of collectReferencedPackageRuntimeModulePaths(modules)) {
		refreshed[modulePath] = createPackageRuntimeModuleSource(packageId)
		// The regenerated per-package module imports its sibling shared runtime
		// module; make sure that target exists even when nothing else in the
		// scanned modules referenced it.
		const siblingRuntimePath = normalizeWorkspaceModulePath(
			joinPath(dirname(dirname(modulePath)), 'runtime.js'),
		)
		refreshed[siblingRuntimePath] = createRuntimeModuleSource()
	}
	return refreshed
}

function isStrippableKodyRuntimeModulePath(modulePath: string) {
	return (
		isKodyRuntimeModulePath(modulePath) ||
		parsePackageRuntimeModulePathPackageId(modulePath) != null
	)
}

export function stripKodyRuntimeModules(modules: WorkerLoaderModules) {
	let stripped: WorkerLoaderModules | null = null
	for (const modulePath of Object.keys(modules)) {
		if (!isStrippableKodyRuntimeModulePath(modulePath)) continue
		stripped ??= { ...modules }
		delete stripped[modulePath]
	}
	return stripped ?? modules
}

export function createExecuteEntrypointSource(input: { modulePath: string }) {
	return `
import userEntrypoint from ${JSON.stringify(input.modulePath)};

export default async function __kodyExecuteEntrypoint(input) {
	if (typeof userEntrypoint !== 'function') {
		throw new Error('Kody execute modules must default export a function.');
	}
	return await userEntrypoint(input);
}
`.trim()
}

export function createAppEntrypointSource(input: { modulePath: string }) {
	return `
import * as userModule from ${JSON.stringify(input.modulePath)};
export * from ${JSON.stringify(input.modulePath)};

function resolvePackageAppHandler() {
  const candidate = userModule.default ?? userModule;
  if (typeof candidate === 'function') {
    return candidate;
  }
  if (candidate && typeof candidate.fetch === 'function') {
    return candidate.fetch.bind(candidate);
  }
  // Read "fetch" reflectively: a static userModule.fetch access makes esbuild
  // emit an import-is-undefined warning for every app without a named fetch
  // export.
  const moduleFetch = Reflect.get(userModule, 'fetch');
  if (typeof moduleFetch === 'function') {
    return moduleFetch;
  }
  throw new Error(
    'Kody package apps must export a fetch handler via default export or named fetch.',
  );
}

const handler = resolvePackageAppHandler();

export default {
  async fetch(request, env, ctx) {
    return await handler(request, env, ctx);
  },
};
`.trim()
}

export function createPackageImportProxySource(input: { targetPath: string }) {
	return `
export * from ${JSON.stringify(input.targetPath)};
import * as __kodyPackageModule from ${JSON.stringify(input.targetPath)};
export default __kodyPackageModule.default;
`.trim()
}

/**
 * Static-import proxy stamped with the callee saved-package id: function
 * valued exports are wrapped in the call-metering Proxy from the runtime
 * module (`__kodyMeterStaticPackageExport`), non-function exports pass
 * through unchanged. The `export * from` passthrough stays first so any
 * export name the bundler could not statically discover keeps working (it
 * is just not metered) — explicitly re-exported wrapped names shadow the
 * star re-export per the ES module ambiguity rules. Only the static import
 * rewrite uses this variant; dynamic package import proxies keep the plain
 * source above.
 */
export function createMeteredPackageImportProxySource(input: {
	targetPath: string
	runtimeSpecifier: string
	packageId: string
	exportNames: Array<string>
}) {
	const packageIdJson = JSON.stringify(input.packageId)
	const namedExportLines = input.exportNames.flatMap((exportName, index) => {
		if (exportName === 'default') return []
		const localName = `__kodyMeteredStaticExport${index}`
		return [
			`const ${localName} = __kodyMeterStaticPackageExport(${packageIdJson}, __kodyPackageModule.${exportName});`,
			`export { ${localName} as ${exportName} };`,
		]
	})
	return `
export * from ${JSON.stringify(input.targetPath)};
import * as __kodyPackageModule from ${JSON.stringify(input.targetPath)};
import { __kodyMeterStaticPackageExport } from ${JSON.stringify(
		input.runtimeSpecifier,
	)};
export default __kodyMeterStaticPackageExport(${packageIdJson}, __kodyPackageModule.default);
${namedExportLines.join('\n')}
`.trim()
}

export function buildRemovedDynamicKodyImportMessage(specifier: string) {
	return (
		`Dynamic import(${JSON.stringify(specifier)}) was removed: use a static import ` +
		`(import fn from ${JSON.stringify(specifier)}) — execute bundles always see the current ` +
		`published version, and saved packages declare the dependency in package.json#kody.dependencies — ` +
		`or packages.invoke({ kodyId, exportName, params }) when the target package is data.`
	)
}

export function createDynamicPackageImportProxySource(input: {
	targetPath: string
}) {
	return `
// ${dynamicPackageImportResolvedMarker}
${createPackageImportProxySource(input)}
`.trim()
}

export function createComputedDynamicImportGuardSource(input: {
	helperName: string
}) {
	return `
const ${input.helperName} = async (specifier) => {
	if (typeof specifier === 'string' && specifier.startsWith(${JSON.stringify(
		packageSpecifierPrefix,
	)})) {
		throw new Error(
			'Dynamic kody:@ package imports were removed. Use a static import (import fn from "kody:@scope/package/export") when the package name is known at write time, or packages.invoke({ kodyId, exportName, params }) when the target is data.',
		);
	}
	return await import(specifier);
};
`.trim()
}

export function createRemovedDynamicKodyImportHelperSource(input: {
	helperName: string
}) {
	// Literal dynamic kody:@ imports were removed with the static-first model.
	// The bundler rewrites each call site to this helper so the failure is an
	// actionable teaching error naming the replacement, not a resolution error.
	return `
const ${input.helperName} = (specifier) => {
	throw new Error(
		'Dynamic import("' + specifier + '") was removed: use a static import (import fn from "' + specifier + '") — execute bundles always see the current published version, and saved packages declare the dependency in package.json#kody.dependencies — or packages.invoke({ kodyId, exportName, params }) when the target package is data.',
	);
};
`.trim()
}

export function createImportableEntrypointSource(input: {
	modulePath: string
}) {
	return `
export * from ${JSON.stringify(input.modulePath)};
import * as userModule from ${JSON.stringify(input.modulePath)};
export default userModule.default;
`.trim()
}

export function* iterateModuleSourceTexts(
	modules: WorkerLoaderModules,
): Generator<[modulePath: string, source: string]> {
	for (const [modulePath, module] of Object.entries(modules)) {
		if (typeof module === 'string') {
			yield [modulePath, module]
			continue
		}
		if (typeof module.js === 'string') {
			yield [modulePath, module.js]
		}
		if (typeof module.cjs === 'string') {
			yield [modulePath, module.cjs]
		}
		if (typeof module.text === 'string') {
			yield [modulePath, module.text]
		}
	}
}
