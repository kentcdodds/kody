import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
}))

vi.mock('@cloudflare/worker-bundler', () => ({
	createFileSystemSnapshot: (...args: Array<unknown>) =>
		mockModule.createFileSystemSnapshot(...args),
}))

vi.mock('@cloudflare/worker-bundler/typescript', () => ({
	createTypescriptLanguageService: (...args: Array<unknown>) =>
		mockModule.createTypescriptLanguageService(...args),
}))

import { runRepoChecks } from './checks.ts'
import { repoBackedJobModuleStyleErrorMessage } from '../jobs/repo-backed-job-entrypoint.ts'

type MockSnapshot = {
	read: ReturnType<typeof vi.fn>
}

type MockTypeScriptFileSystem = MockSnapshot & {
	write: ReturnType<typeof vi.fn>
}

function createSnapshotFromFiles(files: Map<string, string>): MockSnapshot {
	return {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
}

async function collectSnapshotFiles(
	input: AsyncIterable<readonly [string, string]>,
) {
	const snapshotFiles = new Map<string, string>()
	for await (const [path, content] of input) {
		snapshotFiles.set(path, content)
	}
	return snapshotFiles
}

test('runRepoChecks normalizes leading slashes in manifest entrypoints', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'kody.json',
			JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Migrated job',
				description: 'Runs immediately after migration',
				sourceRoot: '/',
				entrypoint: '/src/job.ts',
			}),
		],
		[
			'src/job.ts',
			'async () => ({ ok: true })\n',
		],
		[
			'package.json',
			JSON.stringify({
				name: 'migrated-job',
				private: true,
			}),
		],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'kody.json',
		sourceRoot: '/',
	})

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: true,
				message: 'Entrypoint "src/job.ts" found for bundling.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics for "src/job.ts".',
			}),
		]),
	)
	expect(snapshot.read).toHaveBeenCalledWith('src/job.ts')
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const codemode'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_check__.ts',
		expect.stringContaining('declare function __kodyTypecheckJob'),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith('.__kody_repo_check__.ts')
})

test('runRepoChecks strips repo-session workspace prefixes from snapshot paths', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'/session/kody.json',
			JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Session-backed job',
				description: 'Runs from a repo session workspace',
				sourceRoot: '/',
				entrypoint: '/src/job.ts',
			}),
		],
		[
			'/session/src/job.ts',
			'async () => ({ ok: true })\n',
		],
		[
			'/session/package.json',
			JSON.stringify({
				name: 'session-backed-job',
				private: true,
			}),
		],
	])
	let snapshotFiles = new Map<string, string>()
	const snapshot = createSnapshotFromFiles(snapshotFiles)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn((path: string, content: string) => {
			snapshotFiles.set(path, content)
		}),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockImplementation(async (input) => {
		snapshotFiles = await collectSnapshotFiles(
			input as AsyncIterable<readonly [string, string]>,
		)
		snapshot.read.mockImplementation((path: string) => snapshotFiles.get(path) ?? null)
		return snapshot
	})
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: '/session/kody.json',
		sourceRoot: '/session/',
	})

	expect(result.ok).toBe(true)
	expect(Array.from(snapshotFiles.keys())).toEqual([
		'kody.json',
		'src/job.ts',
		'package.json',
		'.__kody_repo_runtime__.d.ts',
		'.__kody_repo_check__.ts',
	])
	expect(snapshot.read).toHaveBeenCalledWith('src/job.ts')
	expect(snapshot.read).not.toHaveBeenCalledWith('/src/job.ts')
	expect(getSemanticDiagnostics).toHaveBeenCalledWith('.__kody_repo_check__.ts')
})

test('runRepoChecks accepts execute runtime globals for repo-backed jobs', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'kody.json',
			JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Runtime globals job',
				description: 'Uses execute globals',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
		],
		[
			'src/job.ts',
			`async (params) => {
  await codemode.value_get({ name: 'projectId' })
  await storage.get('count')
  return params
}
`,
		],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'kody.json',
		sourceRoot: '/',
	})

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
				message: 'No package.json found in source root; dependency check skipped.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics for "src/job.ts".',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const storage'),
	)
})

test('runRepoChecks accepts codemode globals for repo-backed skills', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'kody.json',
			JSON.stringify({
				version: 1,
				kind: 'skill',
				title: 'Runtime globals skill',
				description: 'Uses execute globals',
				sourceRoot: '/',
				entrypoint: 'src/skill.ts',
			}),
		],
		[
			'src/skill.ts',
			`async (params) => {
  const result = await codemode.value_get({ name: 'projectId' })
  return { params, result }
}
`,
		],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'kody.json',
		sourceRoot: '/',
	})

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics for "src/skill.ts".',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const codemode'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_check__.ts',
	expect.stringContaining('declare function __kodyTypecheckSkill'),
	)
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const storage'),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith('.__kody_repo_check__.ts')
})

test('runRepoChecks still reports unknown globals for repo-backed jobs', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'kody.json',
			JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Broken job',
				description: 'Uses unknown runtime symbol',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
		],
		['src/job.ts', 'async () => totallyMissingThing()\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn((path: string) =>
		path === '.__kody_repo_check__.ts'
			? [
					{
						messageText: "Cannot find name 'totallyMissingThing'.",
						start: 0,
						file: {
							getLineAndCharacterOfPosition() {
								return {
									line: 0,
									character: 11,
								}
							},
						},
					},
				]
			: [],
	)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'kody.json',
		sourceRoot: '/',
	})

	expect(result.ok).toBe(false)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'typecheck',
				ok: false,
				message: "src/job.ts:1:12 Cannot find name 'totallyMissingThing'.",
			}),
		]),
	)
})

test('runRepoChecks rejects module-style repo-backed job entrypoints', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'kody.json',
			JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Module job',
				description: 'Uses exports',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
		],
		['src/job.ts', 'export default async () => ({ ok: true })\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'kody.json',
		sourceRoot: '/',
	})

	expect(result.ok).toBe(false)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'typecheck',
				ok: false,
				message: `src/job.ts ${repoBackedJobModuleStyleErrorMessage}`,
			}),
		]),
	)
	expect(getSemanticDiagnostics).not.toHaveBeenCalled()
})
