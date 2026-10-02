import { expect, test } from 'vitest'
import {
	moduleSourceHasInlinedKodyRuntime,
	rewriteInlinedLocalExecuteBundleSource,
} from './rewrite-inlined-local-runtime.ts'
import { runtimeModulePath } from './module-graph-paths.ts'

const packageId = '2cc996d8-c0f5-4339-a6c1-9b6206123e96'
const dependencyPackageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

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
var KodyRuntime2 = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });

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
	expect(result.source).toContain(
		'__kodyCreatePackageBoundOauthClientCredentials',
	)
	expect(result.source).toContain(JSON.stringify(packageId))
	expect(result.source).toContain('// virtual:.__kody_root__/src/request.ts')
	expect(result.source).not.toContain(
		'__kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch")',
	)
	expect(result.source).not.toContain('AsyncLocalStorage')
	expect(result.source).not.toContain('// virtual:.__kody_virtual__/runtime.js')
	expect(result.source).not.toContain(
		'// virtual:.__kody_virtual__/package-runtime/',
	)
	// Preserve esbuild-renamed package host bindings for author body refs.
	expect(result.source).toContain(
		`var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain(
		`var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain('var packageStorage = packageStorage2;')
	expect(result.source).toContain('var packageSecrets = packageSecrets2;')
	expect(result.source).toContain('var __kodyPackageRuntimeDefault = {')
	expect(result.source).toContain(
		'var KodyRuntime2 = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });',
	)
	expect(result.source).toContain('var KodyRuntime = KodyRuntime2;')
	// Relative hop from nested published bundle up to graph-canonical runtime.
	expect(result.source).toMatch(
		/from ["'](?:\.\.\/)+.__kody_virtual__\/runtime\.js["']/,
	)
	expect(result.source).toContain('var DROPBOX_INTEGRATION = "dropbox"')
})

test('rewrite keeps author modules that appear before the inlined runtime', () => {
	const source = `// virtual:.__kody_root__/src/helper.ts
function parse(value) { return String(value); }

// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/entry.ts
export async function main() {
  const fetchFn = await createAuthenticatedFetch("dropbox");
  return parse(typeof fetchFn);
}
`
	const result = rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain('// virtual:.__kody_root__/src/helper.ts')
	expect(result.source).toContain('function parse(value)')
	expect(result.source).toContain('// virtual:.__kody_root__/src/entry.ts')
	expect(result.source).not.toContain('__kodyOptionalRuntimeFunctionExport')
	expect(result.source.indexOf('function parse(value)')).toBeLessThan(
		result.source.indexOf('__kodyCreatePackageBoundAuthenticatedFetch'),
	)
})

test('rewrite prefers the last package-runtime package id', () => {
	const source = `// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");

// virtual:.__kody_virtual__/package-runtime/dependency.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(dependencyPackageId)});

// virtual:.__kody_virtual__/package-runtime/root.js
var packageStorage3 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/entry.ts
export default async function main() { return typeof createAuthenticatedFetch }
`
	const result = rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toContain(
		`__kodyCreatePackageBoundAuthenticatedFetch(${JSON.stringify(packageId)})`,
	)
	expect(result.source).not.toContain(dependencyPackageId)
})

test('rewrite strips duplicate runtime banners without discarding author code', () => {
	const source = `// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch2 = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
// virtual:.__kody_root__/src/entry.ts
export default async function main() { return 1 }
`
	const result = rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain('// virtual:.__kody_root__/src/entry.ts')
	expect(result.source).not.toContain('__kodyOptionalRuntimeFunctionExport')
	expect(
		result.source.match(
			/var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch/g,
		),
	).toHaveLength(1)
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
