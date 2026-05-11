import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

export const runtimeModulePath = '.__kody_virtual__/runtime.js'
// Bump this when package bundle execution semantics change in a way that is
// not reflected by createRuntimeModuleSource(), such as loader ABI changes.
const runtimeArtifactAbiVersion = 1

export function createRuntimeModuleSource() {
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
	// The exports are evaluated when the module is first imported. The
	// surrounding wrapper resolves the same AsyncLocalStorage off the
	// well-known symbol and calls `storage.run(runtime, async () => {
	// await import(...) })`. Optional exports still capture the initial
	// value so `if (email) { ... }` guards stay falsy when a wrapper
	// intentionally omits that export.
	//
	// `codemode` is different: every execute/package runtime should provide
	// it, and Worker module loaders may evaluate this virtual module before
	// the wrapper installs the per-run store. In that preload case, expose a
	// late-bound proxy so named imports like `import { codemode } from
	// 'kody:runtime'` still resolve against the current AsyncLocalStorage
	// store at call time instead of freezing as undefined.
	return `
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
			return typeof value === 'function' ? value.bind(runtimeExport) : value;
		},
		has(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return false;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			return runtimeExport != null && property in runtimeExport;
		},
	});
}

const __kodyInitialRuntime = __kodyRuntimeStorage.getStore();
const runtime = __kodyInitialRuntime ?? {};
const __kodyCodemode =
	__kodyInitialRuntime === undefined
		? __kodyCreateRuntimeObjectProxy('codemode')
		: runtime.codemode;

export const codemode = __kodyCodemode;
export const storage = runtime.storage;
export const refreshAccessToken = runtime.refreshAccessToken;
export const createAuthenticatedFetch = runtime.createAuthenticatedFetch;
export const packageContext = runtime.packageContext ?? null;
export const serviceContext = runtime.serviceContext ?? null;
export const service = runtime.service ?? null;
export const packageSecrets = runtime.packageSecrets ?? null;
export const email = runtime.email ?? null;
export const workflows = runtime.workflows ?? null;
export const packages = runtime.packages ?? null;

export default
	__kodyInitialRuntime === undefined
		? { ...runtime, codemode: __kodyCodemode }
		: runtime;
`.trim()
}

function fnv1a32(input: string) {
	let hash = 2166136261
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getKodyRuntimeShimRevision() {
	return `abi${runtimeArtifactAbiVersion}-${fnv1a32(createRuntimeModuleSource())}`
}

function isRuntimeModulePath(modulePath: string) {
	return (
		modulePath === runtimeModulePath ||
		modulePath.endsWith(`/${runtimeModulePath}`)
	)
}

export function refreshKodyRuntimeModules(
	modules: WorkerLoaderModules,
): WorkerLoaderModules {
	let refreshed: WorkerLoaderModules | null = null
	for (const modulePath of Object.keys(modules)) {
		if (!isRuntimeModulePath(modulePath)) continue
		refreshed ??= { ...modules }
		refreshed[modulePath] = createRuntimeModuleSource()
	}
	return refreshed ?? modules
}
