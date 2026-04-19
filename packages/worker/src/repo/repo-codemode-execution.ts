import { type RepoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import { type RepoSessionTreeResult } from './types.ts'

export const repoCodemodeModuleTypecheckHarnessPath =
	'.__kody_repo_module_check__.ts'

export const repoBackedModuleEntrypointExportErrorMessage =
	'Repo-backed job and skill entrypoints must default export a function so Kody can invoke them with execute semantics.'

const syntheticRepoEntrypointPath = '.__kody_repo_user_entry__.ts'
const repoCodemodeBundleCacheLimit = 50
const repoCodemodeSourceReadConcurrency = 8
const repoCodemodeSourceMaxFiles = 250
const repoCodemodeSourceMaxBytes = 2 * 1024 * 1024
const repoCodemodeImportExtensionPattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const repoCodemodeBundleCache = new Map<
	string,
	Promise<{
		mainModule: string
		modules: WorkerLoaderModules
	}>
>()

function enforceRepoCodemodeBundleCacheLimit() {
	while (repoCodemodeBundleCache.size > repoCodemodeBundleCacheLimit) {
		const oldestKey = repoCodemodeBundleCache.keys().next().value
		if (oldestKey === undefined) {
			break
		}
		repoCodemodeBundleCache.delete(oldestKey)
	}
}

function stripTrailingSlashes(value: string) {
	return value.replace(/\/+$/, '')
}

function createRelativeImportSpecifier(path: string) {
	const normalizedPath = normalizeRepoWorkspacePath(path).replace(
		repoCodemodeImportExtensionPattern,
		'',
	)
	return JSON.stringify(`./${normalizedPath}`)
}

function toRelativeSourcePath(path: string, sourceRoot: string) {
	const normalizedPath = normalizeRepoWorkspacePath(path)
	const normalizedSourceRoot = stripTrailingSlashes(
		normalizeRepoWorkspacePath(sourceRoot),
	)
	if (!normalizedSourceRoot) return normalizedPath
	if (normalizedPath === normalizedSourceRoot) return ''
	if (normalizedPath.startsWith(`${normalizedSourceRoot}/`)) {
		return normalizedPath.slice(normalizedSourceRoot.length + 1)
	}
	return normalizedPath
}

function collectTreeFilePaths(node: RepoSessionTreeResult): Array<string> {
	if (node.type === 'file') {
		return node.path.trim() ? [node.path] : []
	}
	return (node.children ?? []).flatMap((child: RepoSessionTreeResult) =>
		collectTreeFilePaths(child),
	)
}

export function getRepoSourceRelativePath(path: string, sourceRoot: string) {
	return toRelativeSourcePath(path, sourceRoot)
}

function buildSyntheticEntrypointSource(input: { entryPoint: string }) {
	return `export { default } from ${createRelativeImportSpecifier(input.entryPoint)};
`
}

export async function loadRepoSourceFilesFromSession(input: {
	sessionClient: Pick<RepoSessionRpc, 'readFile' | 'tree'>
	sessionId: string
	userId: string
	sourceRoot: string
}): Promise<Record<string, string>> {
	const tree = await input.sessionClient.tree({
		sessionId: input.sessionId,
		userId: input.userId,
		path: input.sourceRoot,
	})
	const filePaths = collectTreeFilePaths(tree)
	const files: Array<readonly [string, string]> = []
	const encoder = new TextEncoder()
	let nextIndex = 0
	let totalBytes = 0
	let limitError: string | null = null
	let shouldStop = false

	const readNextFile = async () => {
		while (!shouldStop) {
			const fileIndex = nextIndex
			nextIndex += 1
			if (fileIndex >= filePaths.length) return
			const path = filePaths[fileIndex]!
			const file = await input.sessionClient.readFile({
				sessionId: input.sessionId,
				userId: input.userId,
				path,
			})
			if (shouldStop || file.content == null) continue
			const relativePath = toRelativeSourcePath(path, input.sourceRoot)
			if (!relativePath) continue
			if (files.length >= repoCodemodeSourceMaxFiles) {
				limitError = `Repo-backed source root "${input.sourceRoot}" exceeded the ${repoCodemodeSourceMaxFiles}-file bundle limit.`
				shouldStop = true
				return
			}
			const fileBytes = encoder.encode(file.content).byteLength
			if (totalBytes + fileBytes > repoCodemodeSourceMaxBytes) {
				limitError = `Repo-backed source root "${input.sourceRoot}" exceeded the ${repoCodemodeSourceMaxBytes}-byte bundle limit.`
				shouldStop = true
				return
			}
			totalBytes += fileBytes
			files.push([relativePath, file.content] as const)
		}
	}

	await Promise.all(
		Array.from(
			{
				length: Math.max(
					1,
					Math.min(repoCodemodeSourceReadConcurrency, filePaths.length),
				),
			},
			() => readNextFile(),
		),
	)
	if (limitError) {
		throw new Error(limitError)
	}
	return Object.fromEntries(
		files,
	)
}

export async function buildRepoCodemodeBundle(input: {
	sourceFiles: Record<string, string>
	entryPoint: string
	entryPointSource: string
	sourceRoot?: string | null
	cacheKey?: string | null
}): Promise<{
	mainModule: string
	modules: WorkerLoaderModules
}> {
	const buildBundle = async () => {
		const { createWorker } = await import('@cloudflare/worker-bundler')
		const bundle = await createWorker({
			files: {
				...input.sourceFiles,
				[syntheticRepoEntrypointPath]: buildSyntheticEntrypointSource({
					entryPoint: toRelativeSourcePath(
						input.entryPoint,
						input.sourceRoot ?? '/',
					),
				}),
			},
			entryPoint: syntheticRepoEntrypointPath,
		})
		return {
			mainModule: bundle.mainModule,
			modules: bundle.modules,
		}
	}
	const cacheKey = input.cacheKey?.trim() || null
	if (!cacheKey) {
		return buildBundle()
	}
	const cached = repoCodemodeBundleCache.get(cacheKey)
	if (cached) {
		return cached
	}
	const pending = buildBundle().catch((error) => {
		repoCodemodeBundleCache.delete(cacheKey)
		throw error
	})
	repoCodemodeBundleCache.set(cacheKey, pending)
	enforceRepoCodemodeBundleCacheLimit()
	return pending
}

export function createRepoCodemodeWrapper(input: {
	mainModule: string
	includeStorage?: boolean
}) {
	const storagePrelude =
		input.includeStorage === true
			? 'globalThis.storage = storage;'
			: 'delete globalThis.storage;'
	return `async (params) => {
  const __previousGlobals = {
    codemode: globalThis.codemode,
    refreshAccessToken: globalThis.refreshAccessToken,
    createAuthenticatedFetch: globalThis.createAuthenticatedFetch,
    agentChatTurnStream: globalThis.agentChatTurnStream,
    params: globalThis.params,
    storage: globalThis.storage,
  };
  try {
    globalThis.codemode = codemode;
    globalThis.refreshAccessToken = refreshAccessToken;
    globalThis.createAuthenticatedFetch = createAuthenticatedFetch;
    globalThis.agentChatTurnStream = agentChatTurnStream;
    globalThis.params = params;
    ${storagePrelude}
    const __repoModule = await import(${JSON.stringify(`./${input.mainModule}`)});
    const __repoEntrypoint = __repoModule?.default;
    if (typeof __repoEntrypoint !== 'function') {
      throw new Error(${JSON.stringify(repoBackedModuleEntrypointExportErrorMessage)});
    }
    return await __repoEntrypoint(params);
  } finally {
    if (__previousGlobals.codemode === undefined) delete globalThis.codemode;
    else globalThis.codemode = __previousGlobals.codemode;
    if (__previousGlobals.refreshAccessToken === undefined) delete globalThis.refreshAccessToken;
    else globalThis.refreshAccessToken = __previousGlobals.refreshAccessToken;
    if (__previousGlobals.createAuthenticatedFetch === undefined) delete globalThis.createAuthenticatedFetch;
    else globalThis.createAuthenticatedFetch = __previousGlobals.createAuthenticatedFetch;
    if (__previousGlobals.agentChatTurnStream === undefined) delete globalThis.agentChatTurnStream;
    else globalThis.agentChatTurnStream = __previousGlobals.agentChatTurnStream;
    if (__previousGlobals.params === undefined) delete globalThis.params;
    else globalThis.params = __previousGlobals.params;
    if (__previousGlobals.storage === undefined) delete globalThis.storage;
    else globalThis.storage = __previousGlobals.storage;
  }
}`
}

export function createRepoCodemodeModuleTypecheckHarness(input: {
	entryPoint: string
}) {
	return `/// <reference path="./.__kody_repo_runtime__.d.ts" />
import userEntrypoint from ${createRelativeImportSpecifier(input.entryPoint)};

declare function __kodyTypecheckModule(
  fn: (params?: Record<string, unknown>) => Promise<unknown> | unknown,
): void;

__kodyTypecheckModule(userEntrypoint);
`
}
