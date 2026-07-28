import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	listPackageServices,
	listPackageRetrievers,
	listPackageSubscriptions,
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import {
	assertKodyDescriptionLength,
	type AuthoredPackageJson,
} from '#worker/package-registry/types.ts'
import {
	buildKodyAppBundle,
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from '#worker/package-runtime/module-graph.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from '#worker/package-runtime/package-artifact-targets.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	isTypeDeclarationFilePath,
} from '#worker/package-runtime/static-kody-imports.ts'
import {
	hasTopLevelDefaultExport,
	parseModuleSource,
	type ModuleAstNode,
} from '#worker/module-source.ts'
import {
	createRepoCapabilitiesModuleTypecheckHarness,
	repoBackedModuleEntrypointExportErrorMessage,
	repoCapabilitiesModuleTypecheckHarnessPath,
} from './repo-kody-execution.ts'
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

export type RepoCheckRunResult =
	| {
			ok: true
			results: Array<RepoCheckResult>
			manifest: AuthoredPackageJson
			sourceFiles: Record<string, string>
	  }
	| {
			ok: false
			results: Array<RepoCheckResult>
			/**
			 * Present when the authored package.json parsed and only later checks
			 * failed. Null when the manifest itself is missing or invalid — callers
			 * must use `results` (kind `manifest`) for the failure message.
			 */
			manifest: AuthoredPackageJson | null
			sourceFiles: Record<string, string>
	  }

function toRepoCheckRunResult(input: {
	results: Array<RepoCheckResult>
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}): RepoCheckRunResult {
	const ok = input.results.every((result) => result.ok)
	if (ok) {
		return {
			ok: true,
			results: input.results,
			manifest: input.manifest,
			sourceFiles: input.sourceFiles,
		}
	}
	return {
		ok: false,
		results: input.results,
		manifest: input.manifest,
		sourceFiles: input.sourceFiles,
	}
}

const executeTypecheckPreludePath = '.__kody_repo_runtime__.d.ts'
const repoChecksSyntheticTsconfigPath = 'tsconfig.json'
const repoChecksSyntheticTsconfigExtendsPath =
	'./.__kody_repo_tsconfig_base__.json'

/**
 * Publish checks materialize the whole source root in memory before bundling
 * and typechecking, so the walk is capped to keep a single check run within
 * Durable Object CPU/memory limits. The caps are intentionally larger than
 * the execution-path caps in `repo-kody-execution.ts` (250 files / 2 MiB)
 * because published packages may ship assets alongside runtime code.
 */
export const repoChecksSourceMaxFiles = 2_000
export const repoChecksSourceMaxTotalBytes = 15 * 1024 * 1024

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

function formatTypeLiteralUnion(values: Array<string>) {
	const uniqueValues = Array.from(new Set(values)).sort((left, right) =>
		left.localeCompare(right),
	)
	if (uniqueValues.length === 0) return 'never'
	return uniqueValues.map((value) => JSON.stringify(value)).join(' | ')
}

function createExecuteTypecheckPrelude(input?: {
	includeStorage?: boolean
	emittedEventTopics?: Array<string>
}) {
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
type KodyPackagesInvokeNormalizedInput = {
  kodyId?: string;
  packageId?: string;
  exportName: string;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
  topic?: string;
};
type KodyPackagesInvokeContract = {
  packageId: string;
  kodyId: string;
  name: string;
  sourceId: string;
  publishedCommit: string | null;
  exportName: string;
  runtimeTarget: string | null;
  description?: string | null;
  typeDefinition?: string | null;
  warnings: string[];
};
type KodyPackagesInvokeCheckResult =
  | {
      ok: true;
      invoke: KodyPackagesInvokeNormalizedInput;
      contract: KodyPackagesInvokeContract;
    }
  | {
      ok: false;
      message: string;
      problems: string[];
      contract?: Partial<KodyPackagesInvokeContract>;
    };
type KodyPackagesRuntime = {
  /**
   * Actively resolves the current published package export, validates the
   * invocation input as far as Kody metadata allows, and returns a normalized
   * input suitable for packages.invoke. This is runtime contract visibility,
   * not compile-time type safety; warnings explain weak validation.
   */
  check(input: KodyPackagesInvokeInput): Promise<KodyPackagesInvokeCheckResult>;
  invoke(input: KodyPackagesInvokeInput): Promise<unknown>;
  /**
   * Runs packages.check first, throws on check failure, then invokes the
   * normalized current package export. Prefer this over packages.invoke when
   * dynamically calling a package whose contract may have changed.
   */
  invokeChecked(input: KodyPackagesInvokeInput): Promise<unknown>;
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
type KodySecretScope = 'user' | 'package' | 'session';
type KodySecretHeadersRuntime = {
  basic(input: {
    usernameSecret: string;
    passwordSecret: string;
    scope?: KodySecretScope | null;
  }): string;
};
type KodyOauthClientCredentialsInput = {
  tokenUrl: string | URL;
  clientIdSecret: string;
  clientSecretSecret: string;
  scope?: KodySecretScope | null;
  authStyle?: 'basic';
  body?: Record<string, string>;
  headers?: Record<string, string>;
};
type KodyEmailRuntime = {
  getMessage(messageId: string): Promise<unknown>;
  getAttachment(attachmentId: string): Promise<unknown>;
  reply(input?: KodyCapabilityArgs): Promise<unknown>;
} | null;
type KodyWorkflowsRuntime = {
  create(input: KodyCapabilityArgs): Promise<unknown>;
} | null;
type KodyDeclaredEventTopic = ${formatTypeLiteralUnion(input?.emittedEventTopics ?? [])};
type KodyEventsRuntime = {
  dispatch(input: {
    topic: KodyDeclaredEventTopic;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
} | null;

declare const capabilities: Record<
  string,
  (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
>;

declare function refreshAccessToken(providerName: string): Promise<string>;
declare function createAuthenticatedFetch(
  providerName: string,
): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
declare const secretHeaders: KodySecretHeadersRuntime;
declare function oauthClientCredentials(
  input: KodyOauthClientCredentialsInput,
): Promise<Record<string, unknown>>;
declare const packageContext: { packageId: string; kodyId: string } | null;
declare const serviceContext: { serviceName: string } | null;
declare const packages: KodyPackagesRuntime | null;
declare const email: KodyEmailRuntime;
declare const workflows: KodyWorkflowsRuntime;
declare const events: KodyEventsRuntime;
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
  export const kody: Record<
    string,
    (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
  >;
  export function refreshAccessToken(providerName: string): Promise<string>;
  export function createAuthenticatedFetch(
    providerName: string,
  ): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
  export const secretHeaders: KodySecretHeadersRuntime;
  export function oauthClientCredentials(
    input: KodyOauthClientCredentialsInput,
  ): Promise<Record<string, unknown>>;
  export const packageContext: { packageId: string; kodyId: string } | null;
  export const serviceContext: { serviceName: string } | null;
  export const packages: KodyPackagesRuntime | null;
  export const storage: ${
		input?.includeStorage === true
			? 'KodyStorageRuntime'
			: 'KodyStorageRuntime | undefined'
	};
  export function packageStorage(): KodyStorageRuntime;
  export const email: KodyEmailRuntime;
  export const workflows: KodyWorkflowsRuntime;
  export const events: KodyEventsRuntime;
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
	emittedEventTopics: Array<string>
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

function toPackageBundleKind(target: PublishedPackageArtifactBuildTarget) {
	switch (target.bundleKind) {
		case 'app':
			return 'app'
		case 'module':
			return 'callable'
		case 'importable-module':
			return 'importable'
		default: {
			const bundleKind: never = target.bundleKind
			void bundleKind
			throw new Error('Unhandled package artifact bundle kind.')
		}
	}
}

function collectPackageBundleTargets(manifest: AuthoredPackageJson) {
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
	for (const target of collectPublishedPackageArtifactTargets(manifest)) {
		remember(target.entryPoint, toPackageBundleKind(target))
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

function collectPackageCallableTypecheckTargets(manifest: AuthoredPackageJson) {
	const targets = new Map<string, PackageCallableTypecheckTarget>()
	const emittedEventTopics = Object.keys(manifest.kody.emits ?? {})
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
			emittedEventTopics,
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
	const parsed = JSON.parse(packageJsonContent) as {
		dependencies?: unknown
	}
	const dependencies = parsed.dependencies
	if (
		dependencies !== undefined &&
		(!dependencies ||
			typeof dependencies !== 'object' ||
			Array.isArray(dependencies))
	) {
		throw new Error('package.json dependencies must be an object when present.')
	}
	return Object.keys(dependencies ?? {}).sort((left, right) =>
		left.localeCompare(right),
	)
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
			failures.push(`${target.path}: ${getErrorMessage(error)}`)
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
				emittedEventTopics: target.emittedEventTopics,
			}),
		)
		input.fileSystem.write(
			repoCapabilitiesModuleTypecheckHarnessPath,
			createRepoCapabilitiesModuleTypecheckHarness({
				entryPoint: target.path,
			}),
		)
		return {
			fileName: target.path,
			diagnostics: input.languageService.getSemanticDiagnostics(
				repoCapabilitiesModuleTypecheckHarnessPath,
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
	emittedEventTopics?: Array<string>
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
	try {
		const diagnostics = getPackageTypecheckDiagnostics({
			targets: input.entryPoints.map((entryPoint) => ({
				path: entryPoint.path,
				includeStorage: entryPoint.includeStorage === true,
				emittedEventTopics: input.emittedEventTopics ?? [],
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
	} finally {
		// Release the compiler program eagerly; large snapshots otherwise keep
		// the whole TypeScript program reachable until GC gets around to it.
		languageService.dispose()
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

const lintPlaceholderPassedMessage = 'Lint placeholder passed for this phase.'
const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const maxAmbientStorageReportedFiles = 5

function moduleImportsAmbientStorage(source: string) {
	let parsed: ModuleAstNode
	try {
		parsed = parseModuleSource(source) as unknown as ModuleAstNode
	} catch {
		return false
	}
	const program = parsed.program as { body?: Array<ModuleAstNode> } | undefined
	const body =
		program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
	if (!Array.isArray(body)) return false
	for (const node of body) {
		if (node?.type !== 'ImportDeclaration') continue
		if ((node as { importKind?: unknown }).importKind === 'type') continue
		const specifier = (node as { source?: { value?: unknown } }).source?.value
		if (specifier !== 'kody:runtime') continue
		const specifiers = (node as { specifiers?: unknown }).specifiers
		if (!Array.isArray(specifiers)) continue
		for (const importSpecifier of specifiers) {
			const typedSpecifier = importSpecifier as {
				type?: string
				importKind?: unknown
				imported?: { name?: unknown; value?: unknown }
			}
			if (typedSpecifier.type !== 'ImportSpecifier') continue
			if (typedSpecifier.importKind === 'type') continue
			const importedName =
				typeof typedSpecifier.imported?.name === 'string'
					? typedSpecifier.imported.name
					: typeof typedSpecifier.imported?.value === 'string'
						? typedSpecifier.imported.value
						: null
			if (importedName === 'storage') return true
		}
	}
	return false
}

function collectAmbientStorageImportFiles(sourceFiles: Record<string, string>) {
	const filePaths: Array<string> = []
	for (const [filePath, source] of Object.entries(sourceFiles)) {
		if (!scannableModuleFilePattern.test(filePath)) continue
		if (isTypeDeclarationFilePath(filePath)) continue
		if (!source.includes('kody:runtime')) continue
		if (moduleImportsAmbientStorage(source)) {
			filePaths.push(filePath)
		}
	}
	return filePaths.sort((left, right) => left.localeCompare(right))
}

/**
 * Storage prescription lint rule (failing): saved-package source must use
 * `packageStorage()` instead of the ambient `storage` binding, which is
 * per-run and is unbound or caller-bound when package code is statically
 * imported into another context. This only runs where repo checks run — new
 * session check runs, session/external publishes, and community fork installs
 * — so already-published artifacts are never re-validated retroactively.
 * Stage two of the ambient-storage removal plan: #817 shipped the advisory
 * nudge, this fails new publishes, and a follow-up removes the ambient
 * binding from package invocation contexts once an operator audit of
 * published artifacts confirms no remaining usage.
 */
function buildLintCheck(sourceFiles: Record<string, string>): {
	ok: boolean
	message: string
} {
	const ambientStorageFiles = collectAmbientStorageImportFiles(sourceFiles)
	if (ambientStorageFiles.length === 0) {
		return { ok: true, message: lintPlaceholderPassedMessage }
	}
	const shownFiles = ambientStorageFiles.slice(
		0,
		maxAmbientStorageReportedFiles,
	)
	const hiddenCount = ambientStorageFiles.length - shownFiles.length
	const fileList =
		shownFiles.map((filePath) => `"${filePath}"`).join(', ') +
		(hiddenCount > 0 ? ` (and ${hiddenCount} more)` : '')
	return {
		ok: false,
		message:
			`Package code imports the ambient \`storage\` helper from 'kody:runtime': ${fileList}. ` +
			"Use `packageStorage()` from 'kody:runtime' for package-owned data instead: it reaches the identical " +
			"bucket in the package's own runtime and keeps working when the code is statically imported into " +
			'another context. Ambient `storage` remains only for ad hoc execute code with a `storageId` bound on ' +
			'the execute call.',
	}
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
	expectedPackageScope?: string
}): Promise<RepoCheckRunResult> {
	const manifestContent = await input.workspace.readFile(input.manifestPath)
	if (manifestContent == null) {
		// Caller-authored source mistake (missing package.json). Return a failed
		// check instead of throwing so MCP publish surfaces checks_failed and
		// does not open a Sentry "platform bug" issue.
		return {
			ok: false,
			results: [
				{
					kind: 'manifest',
					ok: false,
					message: `Manifest "${input.manifestPath}" was not found.`,
				},
			],
			manifest: null,
			sourceFiles: {},
		}
	}
	let manifest: AuthoredPackageJson
	try {
		manifest = parseAuthoredPackageJson({
			content: manifestContent,
			manifestPath: input.manifestPath,
			expectedPackageScope: input.expectedPackageScope,
		})
		assertKodyDescriptionLength(manifest.kody.description)
	} catch (error) {
		// Invalid package.json shape (e.g. kody.dependencies as an object) is a
		// caller fix — keep it on the check result path, not as an exception.
		return {
			ok: false,
			results: [
				{
					kind: 'manifest',
					ok: false,
					message: getErrorMessage(error),
				},
			],
			manifest: null,
			sourceFiles: {},
		}
	}
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
	const sourceWalk = await (async () => {
		const collected: Record<string, string> = {}
		const encoder = new TextEncoder()
		let fileCount = 0
		let totalBytes = 0
		for await (const [path, content] of workspaceFilesForSnapshot({
			workspace: input.workspace,
			root: sourceRoot,
		})) {
			fileCount += 1
			if (fileCount > repoChecksSourceMaxFiles) {
				return {
					ok: false as const,
					message: `Repo checks aborted: source root "${sourceRoot || '/'}" contains more than the ${repoChecksSourceMaxFiles}-file publish check limit. Remove files that should not be published (for example build output, vendored dependencies, or data files) and run the checks again.`,
				}
			}
			totalBytes += encoder.encode(content).byteLength
			if (totalBytes > repoChecksSourceMaxTotalBytes) {
				return {
					ok: false as const,
					message: `Repo checks aborted: source root "${sourceRoot || '/'}" exceeds the ${repoChecksSourceMaxTotalBytes}-byte (${Math.round(repoChecksSourceMaxTotalBytes / (1024 * 1024))} MiB) publish check limit. Remove or shrink large files that should not be published (for example build output, vendored dependencies, or data files) and run the checks again.`,
				}
			}
			collected[path] = content
		}
		return {
			ok: true as const,
			collected,
		}
	})()
	if (!sourceWalk.ok) {
		results.push({
			kind: 'bundle',
			ok: false,
			message: sourceWalk.message,
		})
		return toRepoCheckRunResult({
			results,
			manifest,
			sourceFiles: {},
		})
	}
	const sourceFiles = sourceWalk.collected
	const lintCheck = buildLintCheck(sourceFiles)
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
	// The TypeScript check runs BEFORE bundle validation, inside a helper
	// scope. The language service allocates a large JS heap (the compiler
	// plus a full program over the snapshot) that becomes collectable once
	// this closure returns, while esbuild-wasm memory grown during bundling
	// stays resident for the isolate's lifetime (the wasm instance is a
	// module-level singleton and wasm memories never shrink). Typechecking
	// first keeps peak isolate memory near max(typecheck, bundling) instead
	// of their sum — checks over large multi-entrypoint packages were
	// exceeding the Durable Object memory limit and killing publishes
	// (kentcdodds/kody#987). The reported `results` order is unchanged:
	// bundle before typecheck.
	const typecheckResult: RepoCheckResult = await (async () => {
		if (missingCallableTypecheckTargets.length > 0) {
			return {
				kind: 'typecheck',
				ok: false,
				message: `Typecheck skipped because callable package runtime entrypoint(s) are missing from the repo session snapshot: ${missingCallableTypecheckTargets
					.map((path) => `"${path}"`)
					.join(', ')}.`,
			}
		}
		const callableTargetsMissingDefaultExport =
			collectEntrypointsMissingDefaultExport({
				snapshot,
				targets: callableTypecheckTargets,
			})
		if (callableTargetsMissingDefaultExport.length > 0) {
			return {
				kind: 'typecheck',
				ok: false,
				message: formatMissingDefaultExportMessage(
					callableTargetsMissingDefaultExport,
				),
			}
		}
		if (callableTypecheckTargets.length === 0) {
			return {
				kind: 'typecheck',
				ok: true,
				message: 'No callable package runtime entrypoint(s) to typecheck.',
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
		const { fileSystem, languageService } =
			await createTypescriptLanguageService({
				fileSystem: typecheckFileSystem,
			})
		try {
			const diagnostics = getPackageTypecheckDiagnostics({
				targets: callableTypecheckTargets,
				languageService,
				fileSystem,
			})
			return {
				kind: 'typecheck',
				ok: diagnostics.every((entry) => entry.diagnostics.length === 0),
				message: diagnostics.every((entry) => entry.diagnostics.length === 0)
					? `No semantic diagnostics for ${callableTypecheckTargets.length} callable package runtime entrypoint(s).`
					: formatPackageTypecheckDiagnostics(diagnostics).join('\n'),
			}
		} finally {
			// Release the compiler program before bundling allocates.
			languageService.dispose()
		}
	})()

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
	results.push(typecheckResult)
	results.push({
		kind: 'lint',
		ok: lintCheck.ok,
		message: lintCheck.message,
	})

	return toRepoCheckRunResult({
		results,
		manifest,
		sourceFiles,
	})
}
