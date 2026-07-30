import {
	normalizePackageExportKey,
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { hasTopLevelDefaultExport } from '#worker/module-source.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	type StaticKodyPackageImport,
} from '#worker/package-runtime/static-kody-imports.ts'
import { collectLiteralImportNodes } from '#worker/package-runtime/import-specifiers.ts'
import {
	createRelativeImportSpecifier,
	joinPath,
	resolveWorkspaceSourceFilePath,
} from '#worker/package-runtime/module-graph-paths.ts'
import { type LoadedKodyGraphPackages } from '#worker/package-runtime/module-graph-import-rewriting.ts'
import { packageSpecifierPrefix } from '#worker/package-runtime/package-import-resolution.ts'

type TypecheckFileSystem = {
	read(path: string): string | null
	write(path: string, content: string): void
	delete(path: string): void
	list(prefix?: string): Array<string>
	flush(): Promise<void>
}

type TypecheckDiagnostic = {
	code: number
	messageText: string | { messageText: string; next?: Array<unknown> }
	start?: number
	file?: {
		fileName: string
		getLineAndCharacterOfPosition(position: number): {
			line: number
			character: number
		}
	}
}

type ReusableTypecheckService = {
	fileSystem: TypecheckFileSystem
	languageService: {
		getSyntacticDiagnostics(path: string): Array<TypecheckDiagnostic>
		getSemanticDiagnostics(path: string): Array<TypecheckDiagnostic>
		dispose?(): void
	}
}

const entryPath = 'entry.ts'
const tsconfigPath = 'tsconfig.json'
const runtimeTypesPath = 'kody-runtime.d.ts'
const emptyEntrySource = 'export {}'
const retainedProjectPaths = new Set([
	entryPath,
	runtimeTypesPath,
	tsconfigPath,
])
const unresolvedModuleDiagnosticCodes = new Set([2307, 7016, 2792])
const typecheckModuleSourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const maxExecuteTypecheckSourceBytes = 512 * 1024
const maxExecuteTypecheckPackageFiles = 500
const maxExecuteTypecheckPackageBytes = 5 * 1024 * 1024
const maxPendingExecuteTypechecks = 4
const maxExecuteTypecheckHoldMs = 2_000

class MemoryTypecheckFileSystem implements TypecheckFileSystem {
	readonly #files: Map<string, string>

	constructor(files: Record<string, string>) {
		this.#files = new Map(Object.entries(files))
	}

	read(path: string) {
		return this.#files.get(path) ?? null
	}

	write(path: string, content: string) {
		this.#files.set(path, content)
	}

	delete(path: string) {
		this.#files.delete(path)
	}

	list(prefix?: string) {
		const paths = [...this.#files.keys()]
		return prefix === undefined
			? paths
			: paths.filter((path) => path.startsWith(prefix))
	}

	async flush() {}
}

function createTypecheckTsconfig() {
	return JSON.stringify({
		compilerOptions: {
			allowJs: true,
			allowImportingTsExtensions: true,
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			types: [],
		},
	})
}

function createRuntimeTypes() {
	return `declare module "kody:runtime" {
	export const capabilities: any;
	export const createAuthenticatedFetch: any;
	export const email: any;
	export const events: any;
	export const kody: any;
	export const oauthClientCredentials: any;
	export const packageContext: any;
	export const packageSecrets: any;
	export const packages: any;
	export const packageStorage: any;
	export const refreshAccessToken: any;
	export const secretHeaders: any;
	export const service: any;
	export const serviceContext: any;
	export const storage: any;
	export const workflows: any;
}`
}

let reusableTypecheckServicePromise: Promise<ReusableTypecheckService> | null =
	null
let typecheckQueue = Promise.resolve()
let pendingTypecheckCount = 0

async function loadTypescriptLanguageService() {
	// Keep the multi-megabyte compiler out of the default-off Worker's eager
	// module graph. This is the same lazy-load boundary used by repo checks:
	// only an opted-in execute request pays the compiler import cost.
	const { createTypescriptLanguageService } =
		await import('@cloudflare/worker-bundler/typescript')
	return createTypescriptLanguageService
}

async function getReusableTypecheckService() {
	reusableTypecheckServicePromise ??= loadTypescriptLanguageService().then(
		(createTypescriptLanguageService) =>
			createTypescriptLanguageService({
				fileSystem: new MemoryTypecheckFileSystem({
					[entryPath]: emptyEntrySource,
					[runtimeTypesPath]: createRuntimeTypes(),
					[tsconfigPath]: createTypecheckTsconfig(),
				}),
			}) as Promise<ReusableTypecheckService>,
	)
	const servicePromise = reusableTypecheckServicePromise
	try {
		return await servicePromise
	} catch (error) {
		if (reusableTypecheckServicePromise === servicePromise) {
			reusableTypecheckServicePromise = null
		}
		throw error
	}
}

async function withTypecheckLock<T>(
	phases: ExecuteTypecheckPhaseRecorder,
	callback: (service: ReusableTypecheckService) => T,
) {
	if (pendingTypecheckCount >= maxPendingExecuteTypechecks) {
		throw new ExecuteTypecheckError([
			`The pre-execution TypeScript checker already has ${maxPendingExecuteTypechecks} active or queued requests. Retry after one finishes.`,
		])
	}
	pendingTypecheckCount += 1
	const previous = typecheckQueue
	let release: () => void = () => {}
	typecheckQueue = new Promise<void>((resolve) => {
		release = resolve
	})
	await phases.measure('queue', async () => {
		await previous
	})
	let timeoutId: ReturnType<typeof setTimeout> | null = null
	let startupTimedOut = false
	const servicePromise = getReusableTypecheckService()
	const cachedServicePromise = reusableTypecheckServicePromise
	try {
		const service = await phases.measure(
			'compiler-startup',
			async () =>
				await Promise.race([
					servicePromise,
					new Promise<never>((_resolve, reject) => {
						timeoutId = setTimeout(() => {
							startupTimedOut = true
							reject(
								new ExecuteTypecheckError([
									`The pre-execution TypeScript checker exceeded its ${maxExecuteTypecheckHoldMs}ms service startup budget.`,
								]),
							)
						}, maxExecuteTypecheckHoldMs)
					}),
				]),
		)
		if (timeoutId !== null) {
			clearTimeout(timeoutId)
			timeoutId = null
		}
		const diagnosticsStartedAtMs = Date.now()
		const result = callback(service)
		const elapsedMs = Date.now() - diagnosticsStartedAtMs
		if (elapsedMs > maxExecuteTypecheckHoldMs) {
			// Synchronous LanguageService diagnostics cannot be preempted in this
			// isolate. Do not turn a completed valid check into a false-positive
			// failure; discard the slow service so the next request starts fresh.
			service.languageService.dispose?.()
			reusableTypecheckServicePromise = null
		}
		return result
	} catch (error) {
		if (
			startupTimedOut &&
			cachedServicePromise &&
			reusableTypecheckServicePromise === cachedServicePromise
		) {
			reusableTypecheckServicePromise = null
			void cachedServicePromise.then(
				(service) => service.languageService.dispose?.(),
				() => undefined,
			)
		}
		throw error
	} finally {
		if (timeoutId !== null) clearTimeout(timeoutId)
		pendingTypecheckCount -= 1
		release()
	}
}

function clearRequestFiles(fileSystem: TypecheckFileSystem) {
	for (const path of fileSystem.list()) {
		if (!retainedProjectPaths.has(path)) {
			fileSystem.delete(path)
		}
	}
	// Never retain ad hoc source in the warm compiler between requests.
	fileSystem.write(entryPath, emptyEntrySource)
}

function getStaticExportTarget(input: {
	imported: StaticKodyPackageImport
	packages: LoadedKodyGraphPackages
}) {
	const loaded = input.packages.get(input.imported.packageName)
	if (!loaded) return null
	const exportKey = normalizePackageExportKey(input.imported.exportName)
	const exportTarget = loaded.manifest.exports[exportKey]
	const declaredTypesTarget =
		typeof exportTarget === 'object' ? exportTarget.types : undefined
	const targetPath = declaredTypesTarget
		? resolvePackageExportPath({
				manifest: loaded.manifest,
				exportName: exportKey,
				purpose: 'types',
			})
		: resolvePackageExportPath({
				manifest: loaded.manifest,
				exportName: exportKey,
			})
	const resolvedTargetPath =
		resolveWorkspaceSourceFilePath({
			files: loaded.files,
			path: targetPath,
		}) ?? normalizePackageWorkspacePath(targetPath)
	const source = loaded.files[resolvedTargetPath]
	if (source == null) return null
	return {
		resolvedTargetPath,
		source,
	}
}

function createPackageSourceRoot(packageName: string) {
	return joinPath('package-sources', packageName)
}

function createKodyTypeProxyPath(specifier: string) {
	return `${joinPath('kody-types', specifier.slice('kody:'.length))}.ts`
}

type SourceOffsetReplacement = {
	originalStart: number
	originalEnd: number
	transformedStart: number
	transformedEnd: number
}

function rewriteStaticKodyImports(input: {
	source: string
	modulePath: string
}) {
	const replacements = collectLiteralImportNodes(input.source, {
		includeTypeOnly: true,
	})
		.filter(
			(node) =>
				node.kind === 'static' &&
				node.specifier.startsWith(packageSpecifierPrefix),
		)
		.map((node) => ({
			start: node.start,
			end: node.end,
			value: JSON.stringify(
				createRelativeImportSpecifier(
					input.modulePath,
					createKodyTypeProxyPath(node.specifier),
				),
			),
		}))
		.sort((left, right) => left.start - right.start)
	let cursor = 0
	let transformed = ''
	const offsets: Array<SourceOffsetReplacement> = []
	for (const replacement of replacements) {
		transformed += input.source.slice(cursor, replacement.start)
		const transformedStart = transformed.length
		transformed += replacement.value
		offsets.push({
			originalStart: replacement.start,
			originalEnd: replacement.end,
			transformedStart,
			transformedEnd: transformed.length,
		})
		cursor = replacement.end
	}
	transformed += input.source.slice(cursor)
	return {
		source: transformed,
		toOriginalOffset(transformedOffset: number) {
			let delta = 0
			for (const offset of offsets) {
				if (transformedOffset < offset.transformedStart) break
				if (transformedOffset <= offset.transformedEnd) {
					return offset.originalStart
				}
				delta +=
					offset.transformedEnd -
					offset.transformedStart -
					(offset.originalEnd - offset.originalStart)
			}
			return transformedOffset - delta
		},
	}
}

function writePackageSources(input: {
	fileSystem: TypecheckFileSystem
	packages: LoadedKodyGraphPackages
}) {
	for (const [packageName, loaded] of input.packages) {
		const packageRoot = createPackageSourceRoot(packageName)
		for (const [path, source] of Object.entries(loaded.files)) {
			if (!typecheckModuleSourcePattern.test(path)) continue
			const modulePath = joinPath(
				packageRoot,
				normalizePackageWorkspacePath(path),
			)
			input.fileSystem.write(
				modulePath,
				rewriteStaticKodyImports({
					source,
					modulePath,
				}).source,
			)
		}
	}
}

function assertTypecheckInputWithinLimits(input: {
	source: string
	packages: LoadedKodyGraphPackages
}) {
	const encoder = new TextEncoder()
	const sourceBytes = encoder.encode(input.source).byteLength
	if (sourceBytes > maxExecuteTypecheckSourceBytes) {
		throw new ExecuteTypecheckError([
			`entry.ts exceeds the ${maxExecuteTypecheckSourceBytes}-byte pre-execution TypeScript source limit.`,
		])
	}
	let packageFiles = 0
	let packageBytes = 0
	for (const loaded of input.packages.values()) {
		for (const [path, source] of Object.entries(loaded.files)) {
			if (!typecheckModuleSourcePattern.test(path)) continue
			packageFiles += 1
			packageBytes += encoder.encode(source).byteLength
			if (
				packageFiles > maxExecuteTypecheckPackageFiles ||
				packageBytes > maxExecuteTypecheckPackageBytes
			) {
				throw new ExecuteTypecheckError([
					`Published Kody package types exceed the pre-execution TypeScript graph limit (${maxExecuteTypecheckPackageFiles} files or ${maxExecuteTypecheckPackageBytes} bytes).`,
				])
			}
		}
	}
}

function collectTypecheckImports(input: {
	source: string
	packages: LoadedKodyGraphPackages
}) {
	const imports = collectStaticKodyPackageImportsFromFiles(
		{
			[entryPath]: input.source,
		},
		{
			includeTypeDeclarations: true,
			includeTypeOnly: true,
		},
	)
	for (const loaded of input.packages.values()) {
		imports.push(
			...collectStaticKodyPackageImportsFromFiles(loaded.files, {
				includeTypeDeclarations: true,
				includeTypeOnly: true,
			}),
		)
	}
	return new Map(
		imports.map((imported) => [imported.specifier, imported]),
	).values()
}

function writeKodyTypeProxies(input: {
	fileSystem: TypecheckFileSystem
	source: string
	packages: LoadedKodyGraphPackages
}) {
	for (const imported of collectTypecheckImports(input)) {
		const target = getStaticExportTarget({
			imported,
			packages: input.packages,
		})
		if (!target) continue
		const proxyPath = createKodyTypeProxyPath(imported.specifier)
		const targetPath = joinPath(
			createPackageSourceRoot(imported.packageName),
			target.resolvedTargetPath,
		)
		const targetSpecifier = createRelativeImportSpecifier(proxyPath, targetPath)
		input.fileSystem.write(
			proxyPath,
			[
				`export * from ${JSON.stringify(targetSpecifier)}`,
				hasTopLevelDefaultExport(target.source)
					? `export { default } from ${JSON.stringify(targetSpecifier)}`
					: '',
			]
				.filter(Boolean)
				.join('\n'),
		)
	}
}

function flattenDiagnosticMessage(
	message: TypecheckDiagnostic['messageText'],
): string {
	if (typeof message === 'string') return message
	const nested = Array.isArray(message.next)
		? message.next
				.map((entry) =>
					flattenDiagnosticMessage(entry as TypecheckDiagnostic['messageText']),
				)
				.join(' ')
		: ''
	return nested ? `${message.messageText} ${nested}` : message.messageText
}

function getUnresolvedModuleSpecifier(diagnostic: TypecheckDiagnostic) {
	if (!unresolvedModuleDiagnosticCodes.has(diagnostic.code)) return null
	const message = flattenDiagnosticMessage(diagnostic.messageText)
	return message.match(/module ['"]([^'"]+)['"]/)?.[1] ?? null
}

function isArbitraryNpmImportDiagnostic(diagnostic: TypecheckDiagnostic) {
	const specifier = getUnresolvedModuleSpecifier(diagnostic)
	return Boolean(
		specifier &&
		!specifier.startsWith('.') &&
		!specifier.startsWith('/') &&
		!specifier.startsWith('kody:'),
	)
}

function getLineAndCharacter(source: string, position: number) {
	const prefix = source.slice(0, position)
	const lines = prefix.split('\n')
	return {
		line: lines.length - 1,
		character: lines.at(-1)?.length ?? 0,
	}
}

function formatDiagnostic(input: {
	diagnostic: TypecheckDiagnostic
	originalSource: string
	toOriginalOffset(transformedOffset: number): number
}) {
	const diagnostic = input.diagnostic
	const message = flattenDiagnosticMessage(diagnostic.messageText)
	const location =
		typeof diagnostic.start === 'number' && diagnostic.file
			? getLineAndCharacter(
					input.originalSource,
					input.toOriginalOffset(diagnostic.start),
				)
			: null
	const fileName = diagnostic.file?.fileName.replace(/^\/+/, '') ?? entryPath
	return location
		? `${fileName}:${location.line + 1}:${location.character + 1} TS${diagnostic.code}: ${message}`
		: `${fileName} TS${diagnostic.code}: ${message}`
}

export class ExecuteTypecheckError extends Error {
	readonly diagnostics: Array<string>
	serverTiming: Array<ExecuteServerTimingEntry> | undefined

	constructor(diagnostics: Array<string>) {
		super(
			`Ad hoc execute TypeScript check failed:\n${diagnostics
				.map((diagnostic) => `- ${diagnostic}`)
				.join('\n')}`,
		)
		this.name = 'ExecuteTypecheckError'
		this.diagnostics = diagnostics
	}
}

/**
 * Server-Timing-style phase entry (`name` + `durationMs`) surfaced through the
 * execute tool's structured response so agents can attribute latency.
 */
export type ExecuteServerTimingEntry = {
	name: string
	durationMs: number
}

type ExecuteTypecheckPhaseRecorder = {
	entries: Array<ExecuteServerTimingEntry>
	measure<T>(name: string, run: () => Promise<T> | T): Promise<T>
	measureSync<T>(name: string, run: () => T): T
}

function createTypecheckPhaseRecorder(): ExecuteTypecheckPhaseRecorder {
	const entries: Array<ExecuteServerTimingEntry> = []
	const record = (name: string, startedAtMs: number) => {
		entries.push({
			name: `typecheck-${name}`,
			durationMs: Date.now() - startedAtMs,
		})
	}
	return {
		entries,
		async measure(name, run) {
			const startedAtMs = Date.now()
			try {
				return await run()
			} finally {
				record(name, startedAtMs)
			}
		},
		measureSync(name, run) {
			const startedAtMs = Date.now()
			try {
				return run()
			} finally {
				record(name, startedAtMs)
			}
		},
	}
}

export async function assertAdHocExecuteTypechecks(input: {
	source: string
	packages: LoadedKodyGraphPackages
}): Promise<Array<ExecuteServerTimingEntry>> {
	const phases = createTypecheckPhaseRecorder()
	const totalStartedAtMs = Date.now()
	try {
		assertTypecheckInputWithinLimits(input)
		await withTypecheckLock(phases, ({ fileSystem, languageService }) => {
			clearRequestFiles(fileSystem)
			try {
				const rewrittenEntry = phases.measureSync('project-write', () => {
					const rewritten = rewriteStaticKodyImports({
						source: input.source,
						modulePath: entryPath,
					})
					fileSystem.write(entryPath, rewritten.source)
					writePackageSources({
						fileSystem,
						packages: input.packages,
					})
					writeKodyTypeProxies({
						fileSystem,
						source: input.source,
						packages: input.packages,
					})
					return rewritten
				})
				const diagnostics = phases
					.measureSync('diagnostics', () => [
						...languageService.getSyntacticDiagnostics(entryPath),
						...languageService.getSemanticDiagnostics(entryPath),
					])
					.filter((diagnostic) => !isArbitraryNpmImportDiagnostic(diagnostic))
					.map((diagnostic) =>
						formatDiagnostic({
							diagnostic,
							originalSource: input.source,
							toOriginalOffset: rewrittenEntry.toOriginalOffset,
						}),
					)
				if (diagnostics.length > 0) {
					throw new ExecuteTypecheckError(diagnostics)
				}
			} finally {
				clearRequestFiles(fileSystem)
			}
		})
		phases.entries.push({
			name: 'typecheck-total',
			durationMs: Date.now() - totalStartedAtMs,
		})
		return phases.entries
	} catch (error) {
		phases.entries.push({
			name: 'typecheck-total',
			durationMs: Date.now() - totalStartedAtMs,
		})
		if (error instanceof ExecuteTypecheckError) {
			// Diagnostics failures still report where the time went; the execute
			// tool includes these phases in the failed call's structured timing.
			error.serverTiming = [...phases.entries]
		}
		throw error
	}
}
