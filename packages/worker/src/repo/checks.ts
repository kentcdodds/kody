import {
	getPackageAppEntryPath,
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import {
	createRepoCodemodeModuleTypecheckHarness,
	repoCodemodeModuleTypecheckHarnessPath,
} from './repo-codemode-execution.ts'

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
}

const executeTypecheckPreludePath = '.__kody_repo_runtime__.d.ts'
const repoChecksSyntheticTsconfigPath = 'tsconfig.json'
const repoChecksSyntheticTsconfigExtendsPath =
	'./.__kody_repo_tsconfig_base__.json'

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
	const pattern =
		normalizedRoot === ''
			? '**/*.{ts,tsx,js,jsx,json}'
			: `${normalizedRoot}/**/*.{ts,tsx,js,jsx,json}`
	const files = await input.workspace.glob(pattern)
	for (const file of files) {
		if (file.type !== 'file') continue
		const content = await input.workspace.readFile(file.path)
		if (content == null) continue
		const normalizedPath = normalizeRepoWorkspacePath(file.path)
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

declare const codemode: Record<
  string,
  (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
>;

declare function refreshAccessToken(providerName: string): Promise<string>;
declare function createAuthenticatedFetch(
  providerName: string,
): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
declare function agentChatTurnStream(input: KodyCapabilityArgs): AsyncIterable<unknown>;
${
	input?.includeStorage === true
		? `
declare const storage: {
  id: string;
  get(key: string): Promise<unknown>;
  list(options?: KodyCapabilityArgs): Promise<unknown>;
  sql(query: string, params?: Array<KodyJsonValue>): Promise<unknown>;
  set(key: string, value: KodyJsonValue): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  clear(): Promise<unknown>;
};
`
		: ''
}
`.trim()
}

type PackageTypecheckTarget = {
	path: string
	includeStorage: boolean
}

function collectPackageTypecheckTargets(
	manifest: AuthoredPackageJson,
): Array<PackageTypecheckTarget> {
	const targets = new Map<string, PackageTypecheckTarget>()
	const remember = (path: string, includeStorage: boolean) => {
		const normalizedPath = normalizePackageWorkspacePath(path)
		const existing = targets.get(normalizedPath)
		if (existing) {
			existing.includeStorage = existing.includeStorage || includeStorage
			return
		}
		targets.set(normalizedPath, {
			path: normalizedPath,
			includeStorage,
		})
	}
	const appEntryPath = getPackageAppEntryPath(manifest)
	if (appEntryPath) {
		remember(appEntryPath, false)
	}
	for (const exportName of Object.keys(manifest.exports)) {
		remember(
			resolvePackageExportPath({
				manifest,
				exportName,
			}),
			false,
		)
	}
	for (const job of Object.values(manifest.kody.jobs ?? {})) {
		remember(job.entry, true)
	}
	return Array.from(targets.values())
}

function getPackageTypecheckDiagnostics(input: {
	targets: Array<PackageTypecheckTarget>
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
	const { createFileSystemSnapshot } = await import('@cloudflare/worker-bundler')
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
	const { createTypescriptLanguageService } =
		await import('@cloudflare/worker-bundler/typescript')
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
	const { fileSystem, languageService } = await createTypescriptLanguageService({
		fileSystem: typecheckFileSystem,
	})
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
		return `Package runtime entrypoint(s) missing from the repo session snapshot: ${input.missingEntryPoints
			.map((path) => `"${path}"`)
			.join(', ')}.`
	}
	if (input.targetCount === 0) {
		return 'Package defines no app entry, exports, or jobs to bundle.'
	}
	return `Resolved ${input.targetCount} package runtime entrypoint(s) for bundling.`
}

export async function runRepoChecks(input: {
	workspace: {
		readFile(path: string): Promise<string | null>
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
	}
	manifestPath: string
	sourceRoot: string
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
	const { createFileSystemSnapshot } =
		await import('@cloudflare/worker-bundler')
	const snapshot = await createFileSystemSnapshot(
		workspaceFilesForSnapshot({
			workspace: input.workspace,
			root: sourceRoot,
		}),
	)

	const packageJson = snapshot.read('package.json')
	results.push({
		kind: 'dependencies',
		ok: true,
		message:
			packageJson != null
				? 'package.json found for dependency fingerprinting.'
				: 'No package.json found in source root; dependency check skipped.',
	})

	const entryPoints = collectPackageTypecheckTargets(manifest)
	const missingEntryPoints = entryPoints
		.map((target) => target.path)
		.filter((path) => snapshot.read(path) == null)
	results.push({
		kind: 'bundle',
		ok: missingEntryPoints.length === 0,
		message: formatBundleCheckMessage({
			missingEntryPoints,
			targetCount: entryPoints.length,
		}),
	})

	if (missingEntryPoints.length > 0) {
		results.push({
			kind: 'typecheck',
			ok: false,
			message: `Typecheck skipped because package runtime entrypoint(s) are missing from the repo session snapshot: ${missingEntryPoints
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
		}
	}

	const { createTypescriptLanguageService } =
		await import('@cloudflare/worker-bundler/typescript')
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
	const { fileSystem, languageService } = await createTypescriptLanguageService(
		{
			fileSystem: typecheckFileSystem,
		},
	)
	const diagnostics = getPackageTypecheckDiagnostics({
		targets: entryPoints,
		languageService,
		fileSystem,
	})
	results.push({
		kind: 'typecheck',
		ok: diagnostics.every((entry) => entry.diagnostics.length === 0),
		message: diagnostics.every((entry) => entry.diagnostics.length === 0)
			? `No semantic diagnostics for ${entryPoints.length} package runtime entrypoint(s).`
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
	}
}

