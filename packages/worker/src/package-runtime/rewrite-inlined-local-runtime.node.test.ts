import { expect, test } from 'vitest'
import {
	moduleSourceHasInlinedKodyRuntime,
	rewriteInlinedLocalExecuteBundleSource,
} from './rewrite-inlined-local-runtime.ts'
import { runtimeModulePath } from './module-graph-paths.ts'

const packageId = '2cc996d8-c0f5-4339-a6c1-9b6206123e96'

function inlinedDropboxStyleBundle() {
	return `// virtual:.__kody_virtual__/runtime.js
import { AsyncLocalStorage } from "node:async_hooks";
var __kodyRuntimeStorage = new AsyncLocalStorage();
var __kodyInitialRuntime = __kodyRuntimeStorage.getStore();
function __kodyOptionalRuntimeFunctionExport(exportName) {
  if (__kodyInitialRuntime === void 0) return void 0;
  return () => {};
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var secretHeaders = void 0;
var oauthClientCredentials = void 0;
var runtime_default = { createAuthenticatedFetch };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
var __kodyPackageRuntimeDefault = new Proxy(runtime_default, {
  get(target, property, receiver) {
    if (property === "packageStorage") return packageStorage2;
    if (property === "packageSecrets") return packageSecrets2;
    return Reflect.get(target, property, receiver);
  },
});

// virtual:.__kody_root__/src/request.ts
var DROPBOX_INTEGRATION = "dropbox";
async function getAuthenticatedFetch() {
  return await createAuthenticatedFetch(DROPBOX_INTEGRATION);
}
export async function smokeTest() {
  const fetchFn = await getAuthenticatedFetch();
  return typeof fetchFn;
}
`
}

test('moduleSourceHasInlinedKodyRuntime detects virtual banner and optional CAF export', () => {
	expect(moduleSourceHasInlinedKodyRuntime(inlinedDropboxStyleBundle())).toBe(
		true,
	)
	expect(
		moduleSourceHasInlinedKodyRuntime(
			`import { createAuthenticatedFetch } from "./.__kody_virtual__/runtime.js"
export async function searchMessages() { return typeof createAuthenticatedFetch }`,
		),
	).toBe(false)
})

test('rewriteInlinedLocalExecuteBundleSource replaces inlined ALS runtime with shim factories', () => {
	const modulePath =
		'.__kody_packages__/@kentcdodds/dropbox/.__published_bundle__/2e2f736d6f6b652d74657374/bundle.js'
	const result = rewriteInlinedLocalExecuteBundleSource({
		modulePath,
		source: inlinedDropboxStyleBundle(),
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toContain('__kodyCreatePackageBoundAuthenticatedFetch')
	expect(result.source).toContain(JSON.stringify(packageId))
	expect(result.source).toContain('// virtual:.__kody_root__/src/request.ts')
	expect(result.source).not.toContain(
		'__kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch")',
	)
	expect(result.source).not.toContain('AsyncLocalStorage')
	// Relative hop from nested published bundle up to graph-canonical runtime.
	expect(result.source).toMatch(
		/from ["'](?:\.\.\/)+.__kody_virtual__\/runtime\.js["']/,
	)
	expect(result.source).toContain('var DROPBOX_INTEGRATION = "dropbox"')
})

test('rewriteInlinedLocalExecuteBundleSource leaves external-import bundles alone', () => {
	const source = `import { createAuthenticatedFetch } from "./.__kody_virtual__/runtime.js"
export async function searchMessages() { return typeof createAuthenticatedFetch }`
	const result = rewriteInlinedLocalExecuteBundleSource({
		modulePath:
			'.__kody_packages__/@kentcdodds/google/.__published_bundle__/2e2f63616c656e646172/bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result).toEqual({ source, rewritten: false, packageId: null })
})
