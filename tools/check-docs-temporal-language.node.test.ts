import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkDocumentationTemporalLanguage,
	exemptRelativePaths,
	findTemporalLanguageMatches,
	listDocumentationPaths,
	stripMarkdownCode,
} from './check-docs-temporal-language.ts'

test('stripMarkdownCode removes inline and fenced code while preserving lines', () => {
	const input = [
		'Before `Kody now supports code` after.',
		'',
		'```ts',
		'Kody now supports fenced code.',
		'```',
		'',
		'~~~md',
		'We no longer accept this sample.',
		'~~~',
		'Still prose.',
	].join('\n')

	const stripped = stripMarkdownCode(input)
	expect(stripped.split('\n')).toHaveLength(input.split('\n').length)
	expect(stripped.split('\n')[0]).toHaveLength(
		input.split('\n')[0]?.length ?? 0,
	)
	expect(stripped).not.toContain('Kody now supports')
	expect(stripped).not.toContain('We no longer accept')
	expect(stripped).toMatch(/^Before +after\./)
	expect(stripped).toContain('Still prose.')
})

test('stripMarkdownCode binds fences by character and minimum length', () => {
	const content = [
		'~~~~md',
		'~~~',
		'Kody now supports fenced code.',
		'```',
		'~~~~',
		'Kody now supports prose.',
	].join('\n')
	const matches = findTemporalLanguageMatches({
		relativePath: 'docs/use/example.md',
		content,
	})

	expect(matches).toEqual([
		expect.objectContaining({ line: 6, pattern: 'Kody now' }),
		expect.objectContaining({
			line: 6,
			pattern: 'now support/accept/require/use/store/return',
		}),
	])
})

test('stripMarkdownCode masks multi-backtick inline code spans', () => {
	const content = [
		'Before ``code `x` Kody now supports hidden`` after.',
		'Kody now supports prose.',
	].join('\n')
	const stripped = stripMarkdownCode(content)
	const matches = findTemporalLanguageMatches({
		relativePath: 'docs/use/example.md',
		content,
	})

	expect(stripped.split('\n')[0]).toHaveLength(
		content.split('\n')[0]?.length ?? 0,
	)
	expect(matches).toEqual([
		expect.objectContaining({ line: 2, pattern: 'Kody now' }),
		expect.objectContaining({
			line: 2,
			pattern: 'now support/accept/require/use/store/return',
		}),
	])
})

test.each([
	['Now we reject invalid manifests.', 'now we'],
	['We now reject invalid manifests.', 'we now'],
	['We no longer accept legacy manifests.', 'we no longer'],
	['Kody now stores package state.', 'Kody now'],
	['Previously we stored package state elsewhere.', 'previously we'],
	['Formerly we stored package state elsewhere.', 'formerly we'],
	['The API no longer supports that option.', 'no longer support'],
	['The API now supports this option.', 'now support'],
	['This guide was recently updated.', 'recently changed'],
	['The API used to require that option.', 'used to support'],
])('flags rollout prose %j', (content, pattern) => {
	expect(
		findTemporalLanguageMatches({
			relativePath: 'docs/use/example.md',
			content,
		}),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				file: 'docs/use/example.md',
				line: 1,
				pattern: expect.stringContaining(pattern),
			}),
		]),
	)
})

test('reports original line numbers after fenced code', () => {
	const matches = findTemporalLanguageMatches({
		relativePath: 'docs/use/example.md',
		content: [
			'```md',
			'We no longer accept this sample.',
			'```',
			'',
			'Before `sample` Kody now supports packages.',
		].join('\n'),
	})
	expect(matches).toEqual([
		expect.objectContaining({
			line: 5,
			column: 17,
			pattern: 'Kody now',
		}),
		expect.objectContaining({
			line: 5,
			column: 22,
			pattern: 'now support/accept/require/use/store/return',
		}),
	])
})

test('keeps conservative phrasing out of the match set', () => {
	expect(
		findTemporalLanguageMatches({
			relativePath: 'docs/use/example.md',
			content:
				'Run the previous step, then use the current option. The audit previously mapped package ownership.',
		}),
	).toEqual([])
})

test('exempts the principles page and migration procedures', () => {
	expect(exemptRelativePaths).toEqual(
		new Set([
			'docs/contributing/documentation.md',
			'docs/contributing/secret-rotation.md',
		]),
	)
	for (const relativePath of exemptRelativePaths) {
		expect(
			findTemporalLanguageMatches({
				relativePath,
				content: 'We no longer accept legacy manifests.',
			}),
		).toEqual([])
	}
})

test('discovers durable docs and scans them end to end', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'kody-docs-check-'))
	try {
		await Promise.all([
			mkdir(path.join(cwd, 'docs', 'use'), { recursive: true }),
			mkdir(path.join(cwd, '.agents', 'skills', 'example'), {
				recursive: true,
			}),
			mkdir(path.join(cwd, 'packages', 'worker', 'src', 'mcp'), {
				recursive: true,
			}),
			mkdir(
				path.join(cwd, 'packages', 'worker', 'src', 'mcp', 'instructions'),
				{ recursive: true },
			),
		])
		await Promise.all([
			writeFile(path.join(cwd, 'README.md'), 'Current behavior.\n'),
			writeFile(path.join(cwd, 'AGENTS.md'), 'Current behavior.\n'),
			writeFile(
				path.join(cwd, 'docs', 'use', 'example.md'),
				'Kody now supports examples.\n',
			),
			writeFile(
				path.join(cwd, '.agents', 'skills', 'example', 'SKILL.md'),
				'Current behavior.\n',
			),
			writeFile(
				path.join(
					cwd,
					'packages',
					'worker',
					'src',
					'mcp',
					'server-instructions.ts',
				),
				'export const instructions = "Current behavior."\n',
			),
			writeFile(
				path.join(
					cwd,
					'packages',
					'worker',
					'src',
					'mcp',
					'instructions',
					'base-server-fragments.ts',
				),
				'export const fragment = "Current behavior."\n',
			),
		])

		expect(await listDocumentationPaths(cwd)).toEqual([
			'.agents/skills/example/SKILL.md',
			'AGENTS.md',
			'README.md',
			'docs/use/example.md',
			'packages/worker/src/mcp/instructions/base-server-fragments.ts',
			'packages/worker/src/mcp/server-instructions.ts',
		])
		expect(await checkDocumentationTemporalLanguage(cwd)).toEqual([
			expect.objectContaining({
				file: 'docs/use/example.md',
				line: 1,
				pattern: 'Kody now',
			}),
			expect.objectContaining({
				file: 'docs/use/example.md',
				line: 1,
				pattern: 'now support/accept/require/use/store/return',
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
