import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	allowedPackagesInvokePhrasePattern,
	checkDocsNoPackagesInvoke,
	findDisallowedPackagesInvokeMentions,
	listPackagesInvokeScanPaths,
} from './check-docs-no-packages-invoke.ts'

test('allows only the present-tense negation phrase', () => {
	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath: 'docs/use/packages.md',
			content: 'There is no author-facing `packages.invoke`. Interactive MCP',
		}),
	).toEqual([])

	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath: 'docs/guides/package-authoring.md',
			content: 'There is no author-facing packages.invoke.',
		}),
	).toEqual([])

	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath:
				'packages/worker/src/mcp/instructions/base-server-fragments.ts',
			content:
				'Known package exports use a static import. There is no author-facing \\`packages.invoke\\`.',
		}),
	).toEqual([])

	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath: 'packages/worker/src/mcp/server-instructions.ts',
			content: 'Prefer packages.invoke for composition.',
		}),
	).toEqual([
		expect.objectContaining({
			file: 'packages/worker/src/mcp/server-instructions.ts',
			line: 1,
		}),
	])

	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath: 'docs/use/packages.md',
			content:
				'Call `packages.invoke("kody:@scope/pkg/export", { params: {} })`.',
		}),
	).toEqual([
		expect.objectContaining({
			file: 'docs/use/packages.md',
			line: 1,
			column: expect.any(Number),
		}),
	])

	expect(allowedPackagesInvokePhrasePattern.test('unrelated')).toBe(false)
})

test('ignores contributing and runtime paths outside the scan roots', () => {
	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath: 'docs/contributing/package-codemods.md',
			content: 'Rewrites packages.invoke calls.',
		}),
	).toEqual([])

	expect(
		findDisallowedPackagesInvokeMentions({
			relativePath: 'packages/worker/src/mcp/runtime-helper-manifest.ts',
			content: 'Object-only packages.invoke was removed.',
		}),
	).toEqual([])
})

test('lists scan roots and fails a planted teaching mention', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'docs-no-invoke-'))
	try {
		await mkdir(path.join(root, 'docs/use'), { recursive: true })
		await mkdir(path.join(root, 'docs/guides'), { recursive: true })
		await mkdir(path.join(root, 'packages/worker/src/mcp/instructions'), {
			recursive: true,
		})
		await mkdir(path.join(root, '.agents/skills/demo'), { recursive: true })
		await writeFile(path.join(root, 'AGENTS.md'), '# agents\n', 'utf8')
		await writeFile(
			path.join(root, 'packages/worker/src/mcp/server-instructions.ts'),
			'export const x = "Prefer packages.invoke"\n',
			'utf8',
		)
		await writeFile(
			path.join(root, 'docs/use/ok.md'),
			'There is no author-facing `packages.invoke`.\n',
			'utf8',
		)
		await writeFile(
			path.join(root, 'docs/guides/bad.md'),
			'Prefer packages.invoke for composition.\n',
			'utf8',
		)
		await writeFile(
			path.join(root, 'packages/worker/src/mcp/instructions/base.ts'),
			'export const x = "ok"\n',
			'utf8',
		)
		await writeFile(
			path.join(root, '.agents/skills/demo/SKILL.md'),
			'# demo\n',
			'utf8',
		)

		const paths = await listPackagesInvokeScanPaths(root)
		expect(paths).toEqual(
			expect.arrayContaining([
				'AGENTS.md',
				'docs/guides/bad.md',
				'docs/use/ok.md',
				'packages/worker/src/mcp/instructions/base.ts',
				'packages/worker/src/mcp/server-instructions.ts',
				'.agents/skills/demo/SKILL.md',
			]),
		)

		const matches = await checkDocsNoPackagesInvoke(root)
		expect(matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'docs/guides/bad.md',
					excerpt: 'Prefer packages.invoke for composition.',
				}),
				expect.objectContaining({
					file: 'packages/worker/src/mcp/server-instructions.ts',
					excerpt: 'export const x = "Prefer packages.invoke"',
				}),
			]),
		)
		expect(matches).toHaveLength(2)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
