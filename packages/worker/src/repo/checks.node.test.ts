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
			'const run = async () => ({ ok: true })\nvoid run\n',
		],
		[
			'package.json',
			JSON.stringify({
				name: 'migrated-job',
				private: true,
			}),
		],
	])
	const snapshot = {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
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
	expect(getSemanticDiagnostics).toHaveBeenCalledWith('src/job.ts')
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
			'const run = async () => ({ ok: true })\nvoid run\n',
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
	const snapshot = {
		read: vi.fn((path: string) => snapshotFiles.get(path) ?? null),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockImplementation(async (input) => {
		snapshotFiles = new Map<string, string>()
		for await (const [path, content] of input as AsyncIterable<
			readonly [string, string]
		>) {
			snapshotFiles.set(path, content)
		}
		return snapshot
	})
	mockModule.createTypescriptLanguageService.mockResolvedValue({
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
	])
	expect(snapshot.read).toHaveBeenCalledWith('src/job.ts')
	expect(snapshot.read).not.toHaveBeenCalledWith('/src/job.ts')
	expect(getSemanticDiagnostics).toHaveBeenCalledWith('src/job.ts')
})
