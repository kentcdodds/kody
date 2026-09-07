import { expect, test } from 'vitest'
import { runRepoChecks } from './checks.ts'

function createPackageManifest(input: {
	packageName: string
	kodyId: string
	description: string
}) {
	return JSON.stringify({
		name: input.packageName,
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: input.kodyId,
			description: input.description,
		},
	})
}

async function runChecksOnFiles(files: Map<string, string>) {
	return runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({
					path,
					type: 'file',
				}))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})
}

test('runRepoChecks fails publish when README.md or AGENTS.md is missing or empty', async () => {
	const missingAgents = await runChecksOnFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/docs-missing',
					kodyId: 'docs-missing',
					description: 'Missing agent docs',
				}),
			],
			['README.md', '# Human setup\n\n## Intent\n\nDo a thing.\n'],
			['src/index.ts', 'export const ready = true\n'],
		]),
	)
	expect(missingAgents.ok).toBe(false)
	expect(missingAgents.results).toEqual([
		expect.objectContaining({ kind: 'manifest', ok: true }),
		expect.objectContaining({
			kind: 'manifest',
			ok: false,
			message: expect.stringContaining('"AGENTS.md"'),
		}),
	])
	expect(
		missingAgents.results.find((result) => result.ok === false)?.message,
	).toContain('human setup')

	const emptyReadme = await runChecksOnFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/docs-empty',
					kodyId: 'docs-empty',
					description: 'Empty human docs',
				}),
			],
			['README.md', '   \n'],
			['AGENTS.md', '# Agent notes\n\nSmoke-test the default export.\n'],
			['src/index.ts', 'export const ready = true\n'],
		]),
	)
	expect(emptyReadme.ok).toBe(false)
	expect(emptyReadme.results.at(-1)).toEqual(
		expect.objectContaining({
			kind: 'manifest',
			ok: false,
			message: expect.stringContaining('"README.md"'),
		}),
	)
})
