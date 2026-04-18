import {
	getManifestEntrypointPath,
	normalizeRepoWorkspacePath,
	parseRepoManifest,
} from './manifest.ts'
import {
	createRepoCodemodeModuleTypecheckHarness,
	hasModuleStyleRepoBackedEntrypoint,
	repoCodemodeModuleTypecheckHarnessPath,
} from './repo-codemode-execution.ts'
import { type RepoManifest } from './types.ts'

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
	manifest: RepoManifest
}

const executeTypecheckPreludePath = '.__kody_repo_runtime__.d.ts'
const executeSnippetTypecheckHarnessPath = '.__kody_repo_check__.ts'
const repoChecksSyntheticTsconfigPath = 'tsconfig.json'
const repoChecksSyntheticTsconfigExtendsPath = './.__kody_repo_tsconfig_base__.json'

type RepoChecksFileSystem = {
	read(path: string): string | null
	write(path: string, content: string): void
	delete(path: string): void
	list(prefix?: string): Array<string>
	flush(): Promise<void>
}

function createRepoChecksFileSystem(input: { fileSystem: RepoChecksFileSystem }) {
	const overlay = new Map<string, string>()
	const deleted = new Set<string>()

	return {
		read(path: string) {
			if (overlay.has(path)) {
				return overlay.get(path) ?? null
			}
			if (deleted.has(path)) {
				return null
			}
			return input.fileSystem.read(path)
		},
		write(path: string, content: string) {
			overlay.set(path, content)
			deleted.delete(path)
		},
		delete(path: string) {
			overlay.delete(path)
			deleted.add(path)
		},
		list(prefix?: string) {
			const listed = new Set(
				input.fileSystem.list(prefix).filter((path) => !deleted.has(path)),
			)
			for (const path of overlay.keys()) {
				if (prefix === undefined || path.startsWith(prefix)) {
					listed.add(path)
				}
			}
			return Array.from(listed)
		},
		async flush() {},
	} satisfies RepoChecksFileSystem
}

function buildRepoChecksTsconfig(
	baseConfigContent: string | null,
) {
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
	options?: {
		lineOffset?: number
	},
) {
	const lineOffset = options?.lineOffset ?? 0
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
			? `${fileName}:${Math.max(0, location.line - lineOffset) + 1}:${location.character + 1} ${message}`
			: `${fileName} ${message}`
	})
}

function createExecuteTypecheckPrelude(input?: {
	includeStorage?: boolean
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

declare const codemode: Record<
  string,
  (args: KodyCapabilityArgs) => Promise<KodyCapabilityResult>
>;

declare function refreshAccessToken(providerName: string): Promise<string>;
declare function createAuthenticatedFetch(
  providerName: string,
): Promise<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
declare function agentChatTurnStream(input: KodyCapabilityArgs): AsyncIterable<unknown>;
${input?.includeStorage === true ? `
declare const storage: {
  id: string;
  get(key: string): Promise<unknown>;
  list(options?: KodyCapabilityArgs): Promise<unknown>;
  sql(query: string, params?: Array<KodyJsonValue>): Promise<unknown>;
  set(key: string, value: KodyJsonValue): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  clear(): Promise<unknown>;
};
` : ''}
`.trim()
}

function createExecuteSnippetTypecheckHarness(input: {
	fnName: string
	source: string
}): string {
	return `/// <reference path="./${executeTypecheckPreludePath}" />
declare function ${input.fnName}(fn: (params?: Record<string, unknown>) => Promise<unknown>): void; ${input.fnName}(
${input.source}
);
`
}

function getRepoTypecheckDiagnostics(input: {
	manifest: RepoManifest
	entryPoint: string
	entryPointSource: string
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
}): {
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
	lineOffset?: number
} {
	switch (input.manifest.kind) {
		case 'app':
			return {
				fileName: input.entryPoint,
				diagnostics: input.languageService.getSemanticDiagnostics(input.entryPoint),
			}
		case 'skill': {
			input.fileSystem.write(
				executeTypecheckPreludePath,
				createExecuteTypecheckPrelude(),
			)
			const harnessPath = hasModuleStyleRepoBackedEntrypoint(input.entryPointSource)
				? repoCodemodeModuleTypecheckHarnessPath
				: executeSnippetTypecheckHarnessPath
			const isModuleHarness =
				harnessPath === repoCodemodeModuleTypecheckHarnessPath
			input.fileSystem.write(
				harnessPath,
				isModuleHarness
					? createRepoCodemodeModuleTypecheckHarness({
							entryPoint: input.entryPoint,
						})
					: createExecuteSnippetTypecheckHarness({
							fnName: '__kodyTypecheckSkill',
							source: input.entryPointSource,
						}),
			)
			return {
				fileName: input.entryPoint,
				diagnostics: input.languageService.getSemanticDiagnostics(harnessPath),
				lineOffset: harnessPath === executeSnippetTypecheckHarnessPath ? 2 : 0,
			}
		}
		case 'job': {
			input.fileSystem.write(
				executeTypecheckPreludePath,
				createExecuteTypecheckPrelude({
					includeStorage: true,
				}),
			)
			const harnessPath = hasModuleStyleRepoBackedEntrypoint(input.entryPointSource)
				? repoCodemodeModuleTypecheckHarnessPath
				: executeSnippetTypecheckHarnessPath
			const isModuleHarness =
				harnessPath === repoCodemodeModuleTypecheckHarnessPath
			input.fileSystem.write(
				harnessPath,
				isModuleHarness
					? createRepoCodemodeModuleTypecheckHarness({
							entryPoint: input.entryPoint,
						})
					: createExecuteSnippetTypecheckHarness({
							fnName: '__kodyTypecheckJob',
							source: input.entryPointSource,
						}),
			)
			return {
				fileName: input.entryPoint,
				diagnostics: input.languageService.getSemanticDiagnostics(harnessPath),
				lineOffset: harnessPath === executeSnippetTypecheckHarnessPath ? 2 : 0,
			}
		}
		default: {
			const exhaustiveManifest: never = input.manifest
			throw new Error(
				`Unhandled repo manifest kind: ${JSON.stringify(exhaustiveManifest)}`,
			)
		}
	}
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
	const manifest = parseRepoManifest({
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

	const entryPoint = getManifestEntrypointPath(manifest)
	results.push({
		kind: 'bundle',
		ok: snapshot.read(entryPoint) != null,
		message:
			snapshot.read(entryPoint) != null
				? `Entrypoint "${entryPoint}" found for bundling.`
				: `Entrypoint "${entryPoint}" is missing from the repo session snapshot.`,
	})

	const entryPointSource = snapshot.read(entryPoint)
	if (entryPointSource == null) {
		results.push({
			kind: 'typecheck',
			ok: false,
			message: `Typecheck skipped because entrypoint "${entryPoint}" is missing from the repo session snapshot.`,
		})
		results.push({
			kind: 'lint',
			ok: true,
			message: 'Lint placeholder passed for this phase.',
		})
		const smokeChecks = manifest.checks?.smoke ?? []
		if (smokeChecks.length > 0) {
			results.push({
				kind: 'smoke',
				ok: true,
				message: `Recorded ${smokeChecks.length} configured smoke check(s).`,
			})
		}
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
	const { fileSystem, languageService } = await createTypescriptLanguageService({
		fileSystem: typecheckFileSystem,
	})
	const { fileName, diagnostics, lineOffset } = getRepoTypecheckDiagnostics({
		manifest,
		entryPoint,
		entryPointSource,
		languageService,
		fileSystem,
	})
	results.push({
		kind: 'typecheck',
		ok: diagnostics.length === 0,
		message:
			diagnostics.length === 0
				? `No semantic diagnostics for "${entryPoint}".`
				: formatTypecheckDiagnostics(fileName, diagnostics, {
						lineOffset,
					}).join('\n'),
	})

	results.push({
		kind: 'lint',
		ok: true,
		message: 'Lint placeholder passed for this phase.',
	})

	const smokeChecks = manifest.checks?.smoke ?? []
	if (smokeChecks.length > 0) {
		results.push({
			kind: 'smoke',
			ok: true,
			message: `Recorded ${smokeChecks.length} configured smoke check(s).`,
		})
	}

	return {
		ok: results.every((result) => result.ok),
		results,
		manifest,
	}
}
