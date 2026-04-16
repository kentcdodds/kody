import { createFileSystemSnapshot } from '@cloudflare/worker-bundler'
import { createTypescriptLanguageService } from '@cloudflare/worker-bundler/typescript'
import { parseRepoManifest } from './manifest.ts'
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

async function* workspaceFilesForSnapshot(input: {
	workspace: {
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
		readFile(path: string): Promise<string | null>
	}
	root: string
}) {
	const normalizedRoot = input.root.replace(/\/+$/, '')
	const pattern =
		normalizedRoot === ''
			? '**/*.{ts,tsx,js,jsx,json}'
			: `${normalizedRoot}/**/*.{ts,tsx,js,jsx,json}`
	const files = await input.workspace.glob(pattern)
	for (const file of files) {
		if (file.type !== 'file') continue
		const content = await input.workspace.readFile(file.path)
		if (content == null) continue
		const relativePath = normalizedRoot
			? file.path.slice(normalizedRoot.length + 1)
			: file.path
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

	const sourceRoot = input.sourceRoot.replace(/^\/+/, '').replace(/\/+$/, '')
	const snapshot = await createFileSystemSnapshot(
		workspaceFilesForSnapshot({
			workspace: input.workspace,
			root: sourceRoot,
		}),
	)

	const packageJson = snapshot.read('package.json')
	results.push({
		kind: 'dependencies',
		ok: packageJson != null,
		message:
			packageJson != null
				? 'package.json found for dependency fingerprinting.'
				: 'No package.json found in source root; dependency check skipped.',
	})

	const entryPoint =
		manifest.kind === 'app' ? manifest.server : manifest.entrypoint
	results.push({
		kind: 'bundle',
		ok: snapshot.read(entryPoint) != null,
		message:
			snapshot.read(entryPoint) != null
				? `Entrypoint "${entryPoint}" found for bundling.`
				: `Entrypoint "${entryPoint}" is missing from the repo session snapshot.`,
	})

	const { languageService } = await createTypescriptLanguageService({
		fileSystem: snapshot,
	})
	const diagnostics = languageService.getSemanticDiagnostics(entryPoint)
	results.push({
		kind: 'typecheck',
		ok: diagnostics.length === 0,
		message:
			diagnostics.length === 0
				? `No semantic diagnostics for "${entryPoint}".`
				: formatTypecheckDiagnostics(entryPoint, diagnostics).join('\n'),
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
