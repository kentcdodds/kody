import { createTypescriptLanguageService } from '@cloudflare/worker-bundler/typescript'
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

async function getReusableTypecheckService() {
	reusableTypecheckServicePromise ??= createTypescriptLanguageService({
		fileSystem: new MemoryTypecheckFileSystem({
			[entryPath]: emptyEntrySource,
			[runtimeTypesPath]: createRuntimeTypes(),
			[tsconfigPath]: createTypecheckTsconfig(),
		}),
	}) as Promise<ReusableTypecheckService>
	try {
		return await reusableTypecheckServicePromise
	} catch (error) {
		reusableTypecheckServicePromise = null
		throw error
	}
}

async function withTypecheckLock<T>(
	callback: (service: ReusableTypecheckService) => Promise<T> | T,
) {
	const previous = typecheckQueue
	let release: () => void = () => {}
	typecheckQueue = new Promise<void>((resolve) => {
		release = resolve
	})
	await previous
	try {
		return await callback(await getReusableTypecheckService())
	} finally {
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
	const replacements = collectLiteralImportNodes(input.source)
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

function collectTypecheckImports(input: {
	source: string
	packages: LoadedKodyGraphPackages
}) {
	const imports = collectStaticKodyPackageImportsFromFiles({
		[entryPath]: input.source,
	})
	for (const loaded of input.packages.values()) {
		imports.push(...collectStaticKodyPackageImportsFromFiles(loaded.files))
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

export async function assertAdHocExecuteTypechecks(input: {
	source: string
	packages: LoadedKodyGraphPackages
}) {
	await withTypecheckLock(async ({ fileSystem, languageService }) => {
		clearRequestFiles(fileSystem)
		try {
			const rewrittenEntry = rewriteStaticKodyImports({
				source: input.source,
				modulePath: entryPath,
			})
			fileSystem.write(entryPath, rewrittenEntry.source)
			writePackageSources({
				fileSystem,
				packages: input.packages,
			})
			writeKodyTypeProxies({
				fileSystem,
				source: input.source,
				packages: input.packages,
			})
			const diagnostics = [
				...languageService.getSyntacticDiagnostics(entryPath),
				...languageService.getSemanticDiagnostics(entryPath),
			]
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
}
