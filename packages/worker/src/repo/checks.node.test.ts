import { expect, test } from 'vitest'
import { runRepoChecks } from './checks.ts'

test('runRepoChecks normalizes leading slashes in manifest entrypoints', async () => {
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
	])

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
})
