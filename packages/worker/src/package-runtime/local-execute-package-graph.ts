import { isPlatformAccountStableUserId } from '#worker/package-registry/scope-grants.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { collectDynamicImportExpressionNodes } from './import-specifiers.ts'
import { prepareKodyGraphFiles } from './module-graph-import-rewriting.ts'
import {
	createPackageProxyPathSegment,
	createRelativeImportSpecifier,
	joinPath,
	normalizeWorkspaceModulePath,
	packageImportProxyPrefix,
	packageSourcePrefix,
	resolveRelativeModulePath,
	rootSourcePrefix,
} from './module-graph-paths.ts'
import {
	createPackageImportProxySource,
	isKodyPublicRuntimeModulePath,
	isKodyRuntimeModulePath,
	parsePackageRuntimeModulePathPackageId,
} from './runtime-source-modules.ts'
import { collectStaticKodyPackageImportsFromFiles } from './static-kody-imports.ts'

export type LocalExecutePackageModule = {
	name: string
	esModule: string
}

export type LocalExecutePackageGraph = {
	modules: Array<LocalExecutePackageModule>
	imports: Array<string>
	warnings: Array<string>
}

export class LocalExecutePackageGraphError extends Error {
	readonly code:
		| 'package_import_unresolved'
		| 'package_import_unpublished'
		| 'unsupported_dynamic_package_import'

	constructor(
		code: LocalExecutePackageGraphError['code'],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'LocalExecutePackageGraphError'
		this.code = code
	}
}

/**
 * Resolve published, stamped `kody:@…` modules for CLI `execute --local`
 * embedding. Does not execute the user module and does not claim a dynamic
 * worker day — callers meter this as an Open API prep operation.
 */
export async function buildLocalExecutePackageGraph(input: {
	env: Env
	baseUrl: string
	userId: string
	code: string
}): Promise<LocalExecutePackageGraph> {
	assertNoLiteralDynamicSavedPackageImports(input.code)

	const sourceFiles = { 'entry.ts': input.code }
	const staticImports = uniqueSpecifiers(
		collectStaticKodyPackageImportsFromFiles(sourceFiles).map(
			(entry) => entry.specifier,
		),
	)
	if (staticImports.length === 0) {
		return { modules: [], imports: [], warnings: [] }
	}

	let prepared: Awaited<ReturnType<typeof prepareKodyGraphFiles>>
	try {
		const allowPlatformScopes = await isPlatformAccountStableUserId(
			input.env.APP_DB,
			input.userId,
		)
		prepared = await prepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles,
			entryPoint: 'entry.ts',
			allowPlatformScopes,
		})
	} catch (error) {
		throw mapPrepareFailure(error, staticImports)
	}

	const modulesByName = new Map<string, string>()
	for (const [modulePath, source] of Object.entries(prepared.files)) {
		const normalized = normalizeWorkspaceModulePath(modulePath)
		if (shouldOmitPreparedModule(normalized)) continue
		modulesByName.set(
			normalized,
			isKodyRuntimeModulePath(normalized)
				? createLocalExecuteRuntimeShimSource()
				: source,
		)
	}

	for (const specifier of staticImports) {
		const proxyPath = joinPath(
			packageImportProxyPrefix,
			`${createPackageProxyPathSegment(specifier)}.js`,
		)
		const proxySource = prepared.files[proxyPath]
		if (typeof proxySource !== 'string') {
			throw new LocalExecutePackageGraphError(
				'package_import_unresolved',
				`Could not resolve saved package import ${specifier} for local execute.`,
			)
		}
		const targetPath = readProxyTargetAbsolutePath(proxyPath, proxySource)
		if (targetPath == null || !targetPath.includes('/.__published_bundle__/')) {
			throw new LocalExecutePackageGraphError(
				'package_import_unpublished',
				`Saved package import ${specifier} has no published importable-module artifact for local execute. Publish the package export, then retry.`,
			)
		}
		if (!modulesByName.has(targetPath)) {
			throw new LocalExecutePackageGraphError(
				'package_import_unpublished',
				`Saved package import ${specifier} is missing its published artifact modules for local execute.`,
			)
		}
		// Alias the exact `kody:@…` specifier the CLI embeds next to user code.
		// Use an unmetered re-export so local workerd does not need cloud
		// static-call metering helpers from the shared runtime. Target must be
		// relative: workerd treats `.__kody_packages__/…` as a relative-path
		// reference from the alias module, not an exact module-name lookup.
		modulesByName.set(
			specifier,
			createPackageImportProxySource({
				targetPath: createRelativeImportSpecifier(specifier, targetPath),
			}),
		)
	}

	const modules = [...modulesByName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, esModule]) => ({ name, esModule }))

	return {
		modules,
		imports: staticImports,
		warnings: [],
	}
}

function assertNoLiteralDynamicSavedPackageImports(code: string) {
	for (const node of collectDynamicImportExpressionNodes(code)) {
		if (node.literalSpecifier?.startsWith(packageSpecifierPrefix)) {
			throw new LocalExecutePackageGraphError(
				'unsupported_dynamic_package_import',
				`Local execute cannot bind literal dynamic import(${JSON.stringify(node.literalSpecifier)}) yet — use a static import.`,
			)
		}
	}
}

function uniqueSpecifiers(specifiers: ReadonlyArray<string>) {
	return [...new Set(specifiers)].sort((left, right) =>
		left.localeCompare(right),
	)
}

function shouldOmitPreparedModule(modulePath: string) {
	if (modulePath === 'package.json') return true
	if (modulePath.startsWith(`${rootSourcePrefix}/`)) return true
	if (isKodyPublicRuntimeModulePath(modulePath)) return true
	// Cloud import proxies are replaced by `kody:@…` aliases in the response.
	if (modulePath.startsWith(`${packageImportProxyPrefix}/`)) return true
	if (isKodyRuntimeModulePath(modulePath)) return false
	if (parsePackageRuntimeModulePathPackageId(modulePath) != null) return false
	// Prefer published importable-module artifacts only — omit live package
	// source and npm dependency copies from a rebuild miss.
	if (modulePath.includes('/.__published_bundle__/')) return false
	if (modulePath.startsWith(`${packageSourcePrefix}/`)) return true
	if (modulePath.startsWith('.__kody_virtual__/')) return false
	return true
}

function readProxyTargetAbsolutePath(proxyPath: string, proxySource: string) {
	const match =
		/export\s*\*\s*from\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(
			proxySource,
		)
	if (!match?.[1]) return null
	let targetSpecifier: string
	try {
		targetSpecifier = JSON.parse(
			match[1].startsWith("'")
				? `"${match[1].slice(1, -1).replaceAll('"', '\\"')}"`
				: match[1],
		) as string
	} catch {
		return null
	}
	if (targetSpecifier.startsWith('./') || targetSpecifier.startsWith('../')) {
		return resolveRelativeModulePath(proxyPath, targetSpecifier)
	}
	return normalizeWorkspaceModulePath(targetSpecifier)
}

function mapPrepareFailure(
	error: unknown,
	imports: ReadonlyArray<string>,
): LocalExecutePackageGraphError {
	if (error instanceof LocalExecutePackageGraphError) return error
	const message =
		error instanceof Error
			? error.message
			: 'Could not resolve package imports.'
	const importList = imports.join(', ')
	if (/not found/i.test(message) || /was not found/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			`Could not resolve saved package import(s) for local bundling (${importList}): ${message}`,
			{ cause: error },
		)
	}
	if (/platform packages are not runnable/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			message,
			{ cause: error },
		)
	}
	if (/sealed secret provider/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			message,
			{ cause: error },
		)
	}
	if (
		/unsupported kody package specifier/i.test(message) ||
		/nested dynamic import/i.test(message)
	) {
		return new LocalExecutePackageGraphError(
			'unsupported_dynamic_package_import',
			message,
			{ cause: error },
		)
	}
	return new LocalExecutePackageGraphError(
		'package_import_unresolved',
		`Could not resolve saved package import(s) for local bundling (${importList}): ${message}`,
		{ cause: error },
	)
}

/**
 * Local workerd supplies `kody:runtime` (CapabilityProxy bridge). Stamped
 * package modules still import `.__kody_virtual__/runtime.js` / package-runtime
 * facades; this shim re-exports the host runtime and binds stamped
 * packageStorage / packageSecrets / createAuthenticatedFetch through
 * CapabilityProxy hops so long-lived OAuth tokens never enter local workerd
 * (kody#2810).
 */
export function createLocalExecuteRuntimeShimSource() {
	return `
import {
	kody,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	email,
	workflows,
	packages,
	events,
	default as __kodyHostRuntimeDefault,
} from "kody:runtime";

export {
	kody,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	email,
	workflows,
	packages,
	events,
};

export async function createAuthenticatedFetch(providerName) {
	const name = String(providerName ?? "").trim();
	if (!name) {
		throw new Error("Integration name is required.");
	}
	return async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const method =
			input instanceof Request ? input.method : (init?.method ?? "GET");
		const headers = Object.fromEntries(
			new Headers(
				input instanceof Request ? input.headers : init?.headers,
			).entries(),
		);
		let body;
		if (input instanceof Request) {
			body = await input.text();
		} else if (typeof init?.body === "string") {
			body = init.body;
		} else if (init?.body != null) {
			throw new Error(
				"Local execute createAuthenticatedFetch only supports string request bodies.",
			);
		}
		const result = await kody.authenticatedFetch({
			providerName: name,
			request: {
				url,
				method,
				headers,
				...(body !== undefined ? { body } : {}),
			},
		});
		const binary = atob(result.bodyBase64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new Response(bytes, {
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
		});
	};
}

export function __kodyCreatePackageBoundStorage(packageId) {
	return function packageStorage() {
		return {
			id: "package:" + encodeURIComponent(packageId),
			get: async (key) =>
				(await kody.packageStorageGet({ packageId, key })).value,
			list: async (options = {}) =>
				await kody.packageStorageList({ ...options, packageId }),
			sql: async (query, params = []) =>
				await kody.packageStorageSql({
					packageId,
					query,
					params,
					writable: true,
				}),
			set: async (key, value) =>
				await kody.packageStorageSet({ packageId, key, value }),
			delete: async (key) =>
				await kody.packageStorageDelete({ packageId, key }),
			clear: async () => await kody.packageStorageClear({ packageId }),
		};
	};
}

export function __kodyCreatePackageBoundSecrets(packageId) {
	return {
		get: async (alias) => {
			const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
			if (!normalizedAlias) {
				throw new Error("packageSecrets.get requires a non-empty alias.");
			}
			const result = await kody.packageSecretGet({
				alias: normalizedAlias,
				__kodySecretAuthorityPackageId: packageId,
			});
			return typeof result?.value === "string" ? result.value : "";
		},
		has: async (alias) => {
			const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
			if (!normalizedAlias) {
				throw new Error("packageSecrets.has requires a non-empty alias.");
			}
			const result = await kody.packageSecretHas({
				alias: normalizedAlias,
				__kodySecretAuthorityPackageId: packageId,
			});
			return result?.has === true;
		},
	};
}

export function __kodyMeterStaticPackageExport(_packageId, exportValue) {
	return exportValue;
}

export function packageStorage() {
	throw new Error(
		"packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. " +
			"Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved package with packageStorage().",
	);
}

function __kodyPackageSecretsUnavailable() {
	throw new Error(
		"packageSecrets is not available in this execution context. It is bound for stamped saved-package modules and saved-package runtime contexts.",
	);
}

export const packageSecrets = {
	get: async () => __kodyPackageSecretsUnavailable(),
	has: async () => __kodyPackageSecretsUnavailable(),
};

const __kodyLocalRuntimeDefault = Object.freeze({
	...(__kodyHostRuntimeDefault && typeof __kodyHostRuntimeDefault === "object"
		? __kodyHostRuntimeDefault
		: {}),
	kody,
	packageStorage,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	packageContext,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
});
export default __kodyLocalRuntimeDefault;
export const KodyRuntime = Object.freeze({
	defaultValue: __kodyLocalRuntimeDefault,
});
`.trim()
}
