import { normalizeCode } from '@cloudflare/codemode'
import { createWorker, type Modules } from '@cloudflare/worker-bundler'
import { type RepoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import { type RepoSessionTreeResult } from './types.ts'

export type RepoCodemodeEntrypointMode = 'snippet' | 'module'

export const repoCodemodeModuleTypecheckHarnessPath =
	'.__kody_repo_module_check__.ts'

export const repoBackedModuleEntrypointExportErrorMessage =
	'Repo-backed job and skill entrypoints that use module syntax must default export a function so Kody can invoke them with execute semantics.'

const syntheticRepoEntrypointPath = '.__kody_repo_user_entry__.ts'
const repoCodemodeBundleCache = new Map<
	string,
	Promise<{
		entrypointMode: RepoCodemodeEntrypointMode
		mainModule: string
		modules: Modules
	}>
>()

function stripTrailingSlashes(value: string) {
	return value.replace(/\/+$/, '')
}

function usesModuleSyntax(code: string) {
	return (
		/^\s*import\b/m.test(code) ||
		/^\s*export\b/m.test(code) ||
		/\bmodule\.exports\b/.test(code) ||
		/\bexports\.[A-Za-z_$][\w$]*/.test(code) ||
		/\bexports\[['"`][A-Za-z_$][\w$]*['"`]\]/.test(code)
	)
}

export function hasModuleStyleRepoBackedEntrypoint(code: string) {
	return usesModuleSyntax(code)
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

function buildSyntheticEntrypointSource(input: {
	entryPoint: string
	entryPointSource: string
	entrypointMode: RepoCodemodeEntrypointMode
}) {
	if (input.entrypointMode === 'snippet') {
		return `const __kodyUserCode = (${normalizeCode(input.entryPointSource)});
export default __kodyUserCode;
`
	}
	return `export { default } from './${input.entryPoint}';
`
}

export function getRepoBackedEntrypointMode(
	code: string,
): RepoCodemodeEntrypointMode {
	return usesModuleSyntax(code) ? 'module' : 'snippet'
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
	const files = await Promise.all(
		filePaths.map(async (path) => {
			const file = await input.sessionClient.readFile({
				sessionId: input.sessionId,
				userId: input.userId,
				path,
			})
			if (file.content == null) return null
			const relativePath = toRelativeSourcePath(path, input.sourceRoot)
			if (!relativePath) return null
			return [relativePath, file.content] as const
		}),
	)
	return Object.fromEntries(
		files.filter((file): file is NonNullable<typeof file> => file != null),
	)
}

export async function buildRepoCodemodeBundle(input: {
	sourceFiles: Record<string, string>
	entryPoint: string
	entryPointSource: string
	cacheKey?: string | null
}): Promise<{
	entrypointMode: RepoCodemodeEntrypointMode
	mainModule: string
	modules: Modules
}> {
	const buildBundle = async () => {
		const entrypointMode = getRepoBackedEntrypointMode(input.entryPointSource)
		const bundle = await createWorker({
			files: {
				...input.sourceFiles,
				[syntheticRepoEntrypointPath]: buildSyntheticEntrypointSource({
					entryPoint: input.entryPoint,
					entryPointSource: input.entryPointSource,
					entrypointMode,
				}),
			},
			entryPoint: syntheticRepoEntrypointPath,
		})
		return {
			entrypointMode,
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
	return pending
}

export function createRepoCodemodeWrapper(input: {
	mainModule: string
	includeStorage?: boolean
}) {
	const storagePrelude =
		input.includeStorage === true
			? '// storage helper is installed by runCodemodeWithRegistry'
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
import userEntrypoint from './${input.entryPoint}';

declare function __kodyTypecheckModule(
  fn: (params?: Record<string, unknown>) => Promise<unknown> | unknown,
): void;

__kodyTypecheckModule(userEntrypoint);
`
}
