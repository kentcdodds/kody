import { type RepoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import { type RepoSessionTreeResult } from './types.ts'

export const repoCodemodeModuleTypecheckHarnessPath =
	'.__kody_repo_module_check__.ts'

export const repoBackedModuleEntrypointExportErrorMessage =
	'Repo-backed job and skill entrypoints must default export a function so Kody can invoke them with execute semantics.'

const repoCodemodeSourceReadConcurrency = 8
const repoCodemodeSourceMaxFiles = 250
const repoCodemodeSourceMaxBytes = 2 * 1024 * 1024
const repoCodemodeImportExtensionPattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

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
	return Object.fromEntries(files)
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
