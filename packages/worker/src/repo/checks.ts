import {
	getPackageAppEntryPath,
	listPackageServices,
	listPackageSubscriptions,
	listPackageRetrievers,
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import {
	buildKodyAppBundle,
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from '#worker/package-runtime/module-graph.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import { hasTopLevelDefaultExport } from '#worker/module-source.ts'
import {
	createRepoCodemodeModuleTypecheckHarness,
	repoBackedModuleEntrypointExportErrorMessage,
	repoCodemodeModuleTypecheckHarnessPath,
} from './repo-codemode-execution.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'

export type RepoCheckKind =
	| 'manifest'
	| 'dependencies'
	| 'bundle'
	| 'typecheck'
	| 'lint'
	| 'smoke'

export type RepoCheckResult = {
	kind: RepoCheckKind
	ok: boolean
	message: string
}

export type RepoCheckRunResult = {
	ok: boolean
	results: Array<RepoCheckResult>
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}

const executeTypecheckPreludePath = '.__kody_repo_runtime__.d.ts'
const repoChecksSyntheticTsconfigPath = 'tsconfig.json'
const repoChecksSyntheticTsconfigExtendsPath =
	'./.__kody_repo_tsconfig_base__.json'

async function loadWorkerBundlerSnapshotTools() {
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
	const { createFileSystemSnapshot } =
		await import('@cloudflare/worker-bundler')
	return {
		createFileSystemSnapshot,
	}
}

async function loadWorkerBundlerTypescriptTools() {
	const { createTypescriptLanguageService } =
		await import('@cloudflare/worker-bundler/typescript')
	return {
		createTypescriptLanguageService,
	}
}

type RepoChecksFileSystem = {
	read(path: string): string | null
	write(path: string, content: string): void
	delete(path: string): void
	list(prefix?: string): Array<string>
	flush(): Promise<void>
}

function normalizeRepoChecksFileSystemPath(path: string) {
	return path.replace(/^\.?\//, '')
}

function createRepoChecksFileSystem(input: {
	fileSystem: RepoChecksFileSystem
}) {
	const overlay = new Map<string, string>()
	const deleted = new Set<string>()

	return {
		read(path: string) {
			const normalizedPath = normalizeRepoChecksFileSystemPath(path)
			if (overlay.has(normalizedPath)) {
				return overlay.get(normalizedPath) ?? null
			}
			if (deleted.has(normalizedPath)) {
				return null
			}
			return input.fileSystem.read(normalizedPath)
		},
		write(path: string, content: string) {
			const normalizedPath = normalizeRepoChecksFileSystemPath(path)
			overlay.set(normalizedPath, content)
			deleted.delete(normalizedPath)
		},
		delete(path: string) {
			const normalizedPath = normalizeRepoChecksFileSystemPath(path)
			overlay.delete(normalizedPath)
			deleted.add(normalizedPath)
		},
		list(prefix?: string) {
			const normalizedPrefix =
				prefix === undefined
					? undefined
					: normalizeRepoChecksFileSystemPath(prefix)
			const listed = new Set(
				input.fileSystem
					.list(normalizedPrefix)
					.map((path) => normalizeRepoChecksFileSystemPath(path))
					.filter((path) => !deleted.has(path)),
			)
			for (const path of overlay.keys()) {
				if (
					normalizedPrefix === undefined ||
					path.startsWith(normalizedPrefix)
				) {
					listed.add(path)
				}
			}
			return Array.from(listed)
		},
		async flush() {},
	} satisfies RepoChecksFileSystem
}

function buildRepoChecksTsconfig(baseConfigContent: string | null) {
	if (baseConfigContent == null) {
		return JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		})
	}
	return JSON.stringify({
		extends: repoChecksSyntheticTsconfigExtendsPath,
		compilerOptions: {
			allowImportingTsExtensions: true,
			noEmit: true,
		},
	})
}

async function* workspaceFilesForSnapshot(input: {
	workspace: {
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
		readFile(path: string): Promise<string | null>
	}
	root: string
}) {
	const normalizedRoot = normalizeRepoWorkspacePath(input.root).replace(
		/\/+$/,
		'',
	)
	const pattern = normalizedRoot === '' ? '**/*' : `${normalizedRoot}/**/*`
	const files = await input.workspace.glob(pattern)
	for (const file of files) {
		if (file.type !== 'file') continue
		const normalizedPath = normalizeRepoWorkspacePath(file.path)
		if (normalizedPath.split('/').includes('.git')) continue
		const content = await input.workspace.readFile(file.path)
		if (content == null) continue
		const relativePath =
			normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
				? normalizedPath.slice(normalizedRoot.length + 1)
				: normalizedPath
		yield [relativePath, content] as const
	}
}

function formatTypecheckDiagnostics(
	fileName: string,
	diagnostics: Array<{
		messageText: unknown
		start?: number
		file?: {
			getLineAndCharacterOfPosition(pos: number): {
				line: number
				character: number
			}
		}
	}>,
) {
	return diagnostics.map((diagnostic) => {
		const location =
			typeof diagnostic.start === 'number' && diagnostic.file
				? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
				: null
		const message =
			typeof diagnostic.messageText === 'string'
				? diagnostic.messageText
				: JSON.stringify(diagnostic.messageText)
		return location
			? `${fileName}:${location.line + 1}:${location.character + 1} ${message}`
			: `${fileName} ${message}`
	})
}

function createExecuteTypecheckPrelude(input?: { includeStorage?: boolean }) {
	return `type KodyJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: KodyJsonValue }
  | Array<KodyJsonValue>;

type KodyCapabilityArgs = Record<string, unknown>;
type KodyCapabilityResult = unknown;
type KodyPackagesInvokeTarget =
  | { kodyId: string; kody_id?: never; packageId?: never; package_id?: never }
  | { kodyId?: never; kody_id: string; packageId?: never; package_id?: never }
  | { kodyId?: never; kody_id?: never; packageId: string; package_id?: never }
  | { kodyId?: never; kody_id?: never; packageId?: never; package_id: string };
type KodyPackagesInvokeExport =
  | { exportName: string; export_name?: never }
  | { exportName?: never; export_name: string };
type KodyPackagesInvokeInput = KodyPackagesInvokeTarget &
  KodyPackagesInvokeExport & {
  params?: Record<string, unknown>;
  idempotencyKey?: string;
  idempotency_key?: string;
  topic?: string | null;
};
type KodyPackagesRuntime = {
  invoke(input: KodyPackagesInvokeInput): Promise<unknown>;
};
type KodyStorageRuntime = {
  id: string;
  get(key: string): Promise<unknown>;
  list(options?: KodyCapabilityArgs): Promise<unknown>;
  sql(query: string, params?: Array<KodyJsonValue>): Promise<unknown>;
  set(key: string, value: KodyJsonValue): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  clear(): Promise<unknown>;
};
type KodyEmailRuntime = {
  getMessage(messageId: string): Promise<unknown>;
  getAttachment(attachmentId: string): Promise<unknown>;
  reply(input?: KodyCapabilityArgs): Promise<unknown>;
} | null;
type KodyWorkflowsRuntime = {
  create(input: KodyCapabilityArgs): Promise<unknown>;
} | null;

declare const codemode: Record<
  string,
  (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
>;

declare function refreshAccessToken(providerName: string): Promise<string>;
declare function createAuthenticatedFetch(
  providerName: string,
): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
declare const packageContext: { packageId: string; kodyId: string } | null;
declare const serviceContext: { serviceName: string } | null;
declare const packages: KodyPackagesRuntime | null;
declare const email: KodyEmailRuntime;
declare const workflows: KodyWorkflowsRuntime;
declare const packageSecrets:
  | {
      get(alias: string): Promise<string>;
      has(alias: string): Promise<boolean>;
    }
  | null;
declare const service:
  | {
      getStatus(): Promise<unknown>;
      shouldStop(): Promise<boolean>;
      setAlarm(runAt: string | Date): Promise<unknown>;
      clearAlarm(): Promise<unknown>;
    }
  | null;

declare module "kody:runtime" {
  export const codemode: Record<
    string,
    (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
  >;
  export function refreshAccessToken(providerName: string): Promise<string>;
  export function createAuthenticatedFetch(
    providerName: string,
  ): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
  export const packageContext: { packageId: string; kodyId: string } | null;
  export const serviceContext: { serviceName: string } | null;
  export const packages: KodyPackagesRuntime | null;
  export const storage: ${
		input?.includeStorage === true
			? 'KodyStorageRuntime'
			: 'KodyStorageRuntime | undefined'
	};
  export const email: KodyEmailRuntime;
  export const workflows: KodyWorkflowsRuntime;
  export const packageSecrets:
    | {
        get(alias: string): Promise<string>;
        has(alias: string): Promise<boolean>;
      }
    | null;
  export const service:
    | {
        getStatus(): Promise<unknown>;
        shouldStop(): Promise<boolean>;
        setAlarm(runAt: string | Date): Promise<unknown>;
        clearAlarm(): Promise<unknown>;
      }
    | null;
}
${
	input?.includeStorage === true
		? `
declare const storage: KodyStorageRuntime;
`
		: ''
}
`.trim()
}

type PackageBundleTarget = {
	path: string
	bundleKind: 'app' | 'callable' | 'importable'
}

type PackageCallableTypecheckTarget = {
	path: string
	includeStorage: boolean
}

function buildBundleTargetKey(target: PackageBundleTarget) {
	return `${target.path}:${target.bundleKind}`
}

function compareBundleTargets(
	left: PackageBundleTarget,
	right: PackageBundleTarget,
) {
	return buildBundleTargetKey(left).localeCompare(buildBundleTargetKey(right))
}

function collectPackageBundleTargets(
	manifest: AuthoredPackageJson,
): Array<PackageBundleTarget> {
	const targets = new Map<string, PackageBundleTarget>()
	const remember = (
		path: string,
		bundleKind: PackageBundleTarget['bundleKind'],
	) => {
		const normalizedPath = normalizePackageWorkspacePath(path)
		targets.set(buildBundleTargetKey({ path: normalizedPath, bundleKind }), {
			path: normalizedPath,
			bundleKind,
		})
	}
	const appEntryPath = getPackageAppEntryPath(manifest)
	if (appEntryPath) {
		remember(appEntryPath, 'app')
	}
	for (const exportName of Object.keys(manifest.exports)) {
		remember(
			resolvePackageExportPath({
				manifest,
				exportName,
			}),
			'importable',
		)
	}
	for (const job of Object.values(manifest.kody.jobs ?? {})) {
		remember(job.entry, 'callable')
	}
	for (const service of listPackageServices(manifest)) {
		remember(service.entry, 'callable')
	}
	for (const subscription of listPackageSubscriptions(manifest)) {
		remember(subscription.handler, 'callable')
	}
	for (const retriever of listPackageRetrievers(manifest)) {
		remember(
			resolvePackageExportPath({
				manifest,
				exportName: retriever.exportName,
			}),
			'callable',
		)
	}
	return Array.from(targets.values()).sort(compareBundleTargets)
}

function collectPackageCallableTypecheckTargets(
	manifest: AuthoredPackageJson,
): Array<PackageCallableTypecheckTarget> {
	const targets = new Map<string, PackageCallableTypecheckTarget>()
	const remember = (path: string, includeStorage: boolean) => {
		const normalizedPath = normalizePackageWorkspacePath(path)
		const existing = targets.get(normalizedPath)
		if (existing) {
			// Preserve the widest runtime global surface when one file is reused.
			existing.includeStorage = existing.includeStorage || includeStorage
			return
		}
		targets.set(normalizedPath, {
			path: normalizedPath,
			includeStorage,
		})
	}
	for (const job of Object.values(manifest.kody.jobs ?? {})) {
		remember(job.entry, true)
	}
	for (const service of listPackageServices(manifest)) {
		remember(service.entry, true)
	}
	for (const subscription of listPackageSubscriptions(manifest)) {
		remember(subscription.handler, true)
	}
	for (const retriever of listPackageRetrievers(manifest)) {
		remember(
			resolvePackageExportPath({
				manifest,
				exportName: retriever.exportName,
			}),
			true,
		)
	}
	return Array.from(targets.values())
}

function parseDeclaredNpmDependencies(packageJsonContent: string | null) {
	if (!packageJsonContent) return []
	try {
		const parsed = JSON.parse(packageJsonContent) as {
			dependencies?: Record<string, string>
		}
		return Object.keys(parsed.dependencies ?? {}).sort((left, right) =>
			left.localeCompare(right),
		)
	} catch {
		return []
	}
}

function pluralize(count: number, singular: string, plural: string) {
	return count === 1 ? singular : plural
}

function formatQuotedList(values: Array<string>) {
	return values.map((value) => `"${value}"`).join(', ')
}

function formatNpmDependencyCheckMessage(input: {
	packageJsonMissing: boolean
	dependencies: Array<string>
}) {
	if (input.packageJsonMissing) {
		return 'No package.json found in source root; dependency check skipped.'
	}
	if (input.dependencies.length === 0) {
		return 'package.json declares no npm dependencies.'
	}
	return `package.json declares ${input.dependencies.length} npm ${pluralize(
		input.dependencies.length,
		'dependency',
		'dependencies',
	)}: ${formatQuotedList(input.dependencies)}.`
}

function getDeclaredStaticKodyPackageDependencies(
	manifest: AuthoredPackageJson,
) {
	return Array.from(
		new Set(
			(manifest.kody.dependencies ?? []).map((dependency) => dependency.trim()),
		),
	).sort((left, right) => left.localeCompare(right))
}

function getImportedStaticKodyPackageDependencies(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}) {
	return Array.from(
		new Set(
			collectStaticKodyPackageImportsFromFiles(input.sourceFiles)
				.map((imported) => imported.packageName)
				.filter((packageName) => packageName !== input.manifest.name),
		),
	).sort((left, right) => left.localeCompare(right))
}

function validateStaticKodyPackageDependencyDeclarations(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}) {
	const declared = getDeclaredStaticKodyPackageDependencies(input.manifest)
	const imported = getImportedStaticKodyPackageDependencies(input)
	const missing = imported.filter(
		(packageName) => !declared.includes(packageName),
	)
	const unused = declared.filter(
		(packageName) => !imported.includes(packageName),
	)
	if (missing.length === 0 && unused.length === 0) {
		return {
			ok: true,
			message:
				declared.length === 0
					? 'package.json#kody.dependencies declares no static Kody package dependencies.'
					: `package.json#kody.dependencies declares ${declared.length} static Kody package ${pluralize(
							declared.length,
							'dependency',
							'dependencies',
						)}: ${formatQuotedList(declared)}.`,
		}
	}
	const details = [
		missing.length > 0 ? `missing ${formatQuotedList(missing)}` : null,
		unused.length > 0 ? `unused ${formatQuotedList(unused)}` : null,
	].filter((detail): detail is string => detail != null)
	return {
		ok: false,
		message: `package.json#kody.dependencies must match direct static kody:@ imports (${details.join('; ')}).`,
	}
}

async function validatePackageBundles(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoints: Array<PackageBundleTarget>
}) {
	const failures: Array<string> = []
	for (const target of input.entryPoints) {
		try {
			if (target.bundleKind === 'app') {
				await buildKodyAppBundle({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
					cacheKey: null,
				})
			} else if (target.bundleKind === 'callable') {
				await buildKodyModuleBundle({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
				})
			} else if (target.bundleKind === 'importable') {
				await buildKodyImportableModuleBundle({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint: target.path,
				})
			} else {
				const exhaustive: never = target.bundleKind
				throw new Error(`Unsupported package bundle target kind: ${exhaustive}`)
			}
		} catch (error) {
			failures.push(
				`${target.path}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return {
		ok: failures.length === 0,
		message:
			failures.length === 0
				? `Bundled ${input.entryPoints.length} package target(s) successfully.`
				: failures.join('\n'),
	}
}

function getPackageTypecheckDiagnostics(input: {
	targets: Array<PackageCallableTypecheckTarget>
	languageService: {
		getSemanticDiagnostics(path: string): Array<{
			messageText: unknown
			start?: number
			file?: {
				getLineAndCharacterOfPosition(pos: number): {
					line: number
					character: number
				}
			}
		}>
	}
	fileSystem: {
		write(path: string, content: string): void
	}
}): Array<{
	fileName: string
	diagnostics: Array<{
		messageText: unknown
		start?: number
		file?: {
			getLineAndCharacterOfPosition(pos: number): {
				line: number
				character: number
			}
		}
	}>
}> {
	return input.targets.map((target) => {
		input.fileSystem.write(
			executeTypecheckPreludePath,
			createExecuteTypecheckPrelude({
				includeStorage: target.includeStorage,
			}),
		)
		input.fileSystem.write(
			repoCodemodeModuleTypecheckHarnessPath,
			createRepoCodemodeModuleTypecheckHarness({
				entryPoint: target.path,
			}),
		)
		return {
			fileName: target.path,
			diagnostics: input.languageService.getSemanticDiagnostics(
				repoCodemodeModuleTypecheckHarnessPath,
			),
		}
	})
}

function formatPackageTypecheckDiagnostics(
	diagnostics: ReturnType<typeof getPackageTypecheckDiagnostics>,
) {
	return diagnostics.flatMap(({ fileName, diagnostics: fileDiagnostics }) =>
		formatTypecheckDiagnostics(fileName, fileDiagnostics),
	)
}

function collectEntrypointsMissingDefaultExport(input: {
	snapshot: { read(path: string): string | null }
	targets: Array<{ path: string }>
}) {
	return [
		...new Set(
			input.targets
				.map((target) => target.path)
				.filter((path) => {
					const source = input.snapshot.read(path)
					return source != null && !hasTopLevelDefaultExport(source)
				}),
		),
	]
}

function formatMissingDefaultExportMessage(paths: Array<string>) {
	return `${repoBackedModuleEntrypointExportErrorMessage} Missing default export in: ${paths
		.map((path) => `"${path}"`)
		.join(', ')}.`
}

export async function typecheckPackageEntrypointsFromSourceFiles(input: {
	sourceFiles: Record<string, string>
	entryPoints: Array<{
		path: string
		includeStorage?: boolean
	}>
}): Promise<{
	ok: boolean
	message: string
}> {
	const { createFileSystemSnapshot } = await loadWorkerBundlerSnapshotTools()
	const snapshot = await createFileSystemSnapshot(
		(async function* () {
			for (const [path, content] of Object.entries(input.sourceFiles)) {
				yield [path, content] as const
			}
		})(),
	)
	const missingEntryPoints = input.entryPoints
		.map((target) => target.path)
		.filter((path) => snapshot.read(path) == null)
	if (missingEntryPoints.length > 0) {
		return {
			ok: false,
			message: `Typecheck skipped because package runtime entrypoint(s) are missing from the published source snapshot: ${missingEntryPoints
				.map((path) => `"${path}"`)
				.join(', ')}.`,
		}
	}
	const missingDefaultExports = collectEntrypointsMissingDefaultExport({
		snapshot,
		targets: input.entryPoints,
	})
	if (missingDefaultExports.length > 0) {
		return {
			ok: false,
			message: formatMissingDefaultExportMessage(missingDefaultExports),
		}
	}
	const typecheckFileSystem = createRepoChecksFileSystem({
		fileSystem: snapshot,
	})
	const baseTsconfig = snapshot.read(repoChecksSyntheticTsconfigPath)
	if (baseTsconfig != null) {
		typecheckFileSystem.write(
			repoChecksSyntheticTsconfigExtendsPath.slice('./'.length),
			baseTsconfig,
		)
	}
	typecheckFileSystem.write(
		repoChecksSyntheticTsconfigPath,
		buildRepoChecksTsconfig(baseTsconfig),
	)
	const { createTypescriptLanguageService } =
		await loadWorkerBundlerTypescriptTools()
	const { fileSystem, languageService } = await createTypescriptLanguageService(
		{
			fileSystem: typecheckFileSystem,
		},
	)
	const diagnostics = getPackageTypecheckDiagnostics({
		targets: input.entryPoints.map((entryPoint) => ({
			path: entryPoint.path,
			includeStorage: entryPoint.includeStorage === true,
		})),
		languageService,
		fileSystem,
	})
	const ok = diagnostics.every((entry) => entry.diagnostics.length === 0)
	return {
		ok,
		message: ok
			? `No semantic diagnostics for ${input.entryPoints.length} package runtime entrypoint(s).`
			: formatPackageTypecheckDiagnostics(diagnostics).join('\n'),
	}
}

function formatBundleCheckMessage(input: {
	missingEntryPoints: Array<string>
	targetCount: number
}) {
	if (input.missingEntryPoints.length > 0) {
		return `Package bundle target(s) missing from the repo session snapshot: ${input.missingEntryPoints
			.map((path) => `"${path}"`)
			.join(', ')}.`
	}
	if (input.targetCount === 0) {
		return 'Package defines no app entry, exports, jobs, services, subscriptions, or retrievers to bundle.'
	}
	return `Resolved ${input.targetCount} package target(s) for bundling.`
}

export async function runRepoChecks(input: {
	workspace: {
		readFile(path: string): Promise<string | null>
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
	}
	manifestPath: string
	sourceRoot: string
	env?: Env
	baseUrl?: string
	userId?: string
}): Promise<RepoCheckRunResult> {
	const manifestContent = await input.workspace.readFile(input.manifestPath)
	if (manifestContent == null) {
		throw new Error(`Manifest "${input.manifestPath}" was not found.`)
	}
	const manifest = parseAuthoredPackageJson({
		content: manifestContent,
		manifestPath: input.manifestPath,
	})
	const results: Array<RepoCheckResult> = [
		{
			kind: 'manifest',
			ok: true,
			message: `Validated ${input.manifestPath}.`,
		},
	]

	const sourceRoot = normalizeRepoWorkspacePath(input.sourceRoot).replace(
		/\/+$/,
		'',
	)
	const sourceFiles = await (async () => {
		const collected: Record<string, string> = {}
		for await (const [path, content] of workspaceFilesForSnapshot({
			workspace: input.workspace,
			root: sourceRoot,
		})) {
			collected[path] = content
		}
		return collected
	})()
	const { createFileSystemSnapshot } = await loadWorkerBundlerSnapshotTools()
	const snapshot = await createFileSystemSnapshot(
		(async function* () {
			for (const [path, content] of Object.entries(sourceFiles)) {
				yield [path, content] as const
			}
		})(),
	)

	const packageJson = snapshot.read('package.json')
	const declaredNpmDependencies = parseDeclaredNpmDependencies(packageJson)
	const staticKodyDependencyCheck =
		validateStaticKodyPackageDependencyDeclarations({
			manifest,
			sourceFiles,
		})
	results.push({
		kind: 'dependencies',
		ok: staticKodyDependencyCheck.ok,
		message: [
			formatNpmDependencyCheckMessage({
				packageJsonMissing: packageJson == null,
				dependencies: declaredNpmDependencies,
			}),
			staticKodyDependencyCheck.message,
		].join(' '),
	})

	const bundleTargets = collectPackageBundleTargets(manifest)
	const callableTypecheckTargets =
		collectPackageCallableTypecheckTargets(manifest)
	const missingBundleTargets = [
		...new Set(
			bundleTargets
				.map((target) => target.path)
				.filter((path) => snapshot.read(path) == null),
		),
	]
	const missingCallableTypecheckTargets = [
		...new Set(
			callableTypecheckTargets
				.map((target) => target.path)
				.filter((path) => snapshot.read(path) == null),
		),
	]
	const bundleContext =
		input.env && input.userId
			? {
					env: input.env,
					baseUrl: input.baseUrl ?? input.sourceRoot,
					userId: input.userId,
				}
			: null
	const bundleCheckResult =
		missingBundleTargets.length > 0
			? {
					ok: false,
					message: formatBundleCheckMessage({
						missingEntryPoints: missingBundleTargets,
						targetCount: bundleTargets.length,
					}),
				}
			: bundleContext
				? await validatePackageBundles({
						...bundleContext,
						sourceFiles,
						entryPoints: bundleTargets,
					})
				: {
						ok: true,
						message: formatBundleCheckMessage({
							missingEntryPoints: missingBundleTargets,
							targetCount: bundleTargets.length,
						}),
					}
	results.push({
		kind: 'bundle',
		ok: bundleCheckResult.ok,
		message: bundleCheckResult.message,
	})

	if (missingCallableTypecheckTargets.length > 0) {
		results.push({
			kind: 'typecheck',
			ok: false,
			message: `Typecheck skipped because callable package runtime entrypoint(s) are missing from the repo session snapshot: ${missingCallableTypecheckTargets
				.map((path) => `"${path}"`)
				.join(', ')}.`,
		})
		results.push({
			kind: 'lint',
			ok: true,
			message: 'Lint placeholder passed for this phase.',
		})
		return {
			ok: results.every((result) => result.ok),
			results,
			manifest,
			sourceFiles,
		}
	}

	const callableTargetsMissingDefaultExport =
		collectEntrypointsMissingDefaultExport({
			snapshot,
			targets: callableTypecheckTargets,
		})
	if (callableTargetsMissingDefaultExport.length > 0) {
		results.push({
			kind: 'typecheck',
			ok: false,
			message: formatMissingDefaultExportMessage(
				callableTargetsMissingDefaultExport,
			),
		})
		results.push({
			kind: 'lint',
			ok: true,
			message: 'Lint placeholder passed for this phase.',
		})
		return {
			ok: results.every((result) => result.ok),
			results,
			manifest,
			sourceFiles,
		}
	}

	if (callableTypecheckTargets.length === 0) {
		results.push({
			kind: 'typecheck',
			ok: true,
			message: 'No callable package runtime entrypoint(s) to typecheck.',
		})
		results.push({
			kind: 'lint',
			ok: true,
			message: 'Lint placeholder passed for this phase.',
		})
		return {
			ok: results.every((result) => result.ok),
			results,
			manifest,
			sourceFiles,
		}
	}

	const typecheckFileSystem = createRepoChecksFileSystem({
		fileSystem: snapshot,
	})
	const baseTsconfig = snapshot.read(repoChecksSyntheticTsconfigPath)
	if (baseTsconfig != null) {
		typecheckFileSystem.write(
			repoChecksSyntheticTsconfigExtendsPath.slice('./'.length),
			baseTsconfig,
		)
	}
	typecheckFileSystem.write(
		repoChecksSyntheticTsconfigPath,
		buildRepoChecksTsconfig(baseTsconfig),
	)
	const { createTypescriptLanguageService } =
		await loadWorkerBundlerTypescriptTools()
	const { fileSystem, languageService } = await createTypescriptLanguageService(
		{
			fileSystem: typecheckFileSystem,
		},
	)
	const diagnostics = getPackageTypecheckDiagnostics({
		targets: callableTypecheckTargets,
		languageService,
		fileSystem,
	})
	results.push({
		kind: 'typecheck',
		ok: diagnostics.every((entry) => entry.diagnostics.length === 0),
		message: diagnostics.every((entry) => entry.diagnostics.length === 0)
			? `No semantic diagnostics for ${callableTypecheckTargets.length} callable package runtime entrypoint(s).`
			: formatPackageTypecheckDiagnostics(diagnostics).join('\n'),
	})

	results.push({
		kind: 'lint',
		ok: true,
		message: 'Lint placeholder passed for this phase.',
	})

	return {
		ok: results.every((result) => result.ok),
		results,
		manifest,
		sourceFiles,
	}
}
