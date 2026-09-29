import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkDocumentationTemporalLanguage,
	exemptRelativePaths,
	exemptRelativePrefixes,
	findTemporalLanguageMatches,
	listDocumentationPaths,
	stripMarkdownCode,
} from './check-docs-temporal-language.ts'

const nowSupportPattern =
	'now support/accept/require/use/store/return/call/read/pass/run'

function find(content: string) {
	return findTemporalLanguageMatches({
		relativePath: 'docs/use/example.md',
		content,
	})
}

function kodyNowAt(line: number) {
	return [
		expect.objectContaining({ line, pattern: 'Kody now' }),
		expect.objectContaining({ line, pattern: nowSupportPattern }),
	]
}

test('stripMarkdownCode preserves lines and only matches durable prose', () => {
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
	expect(stripped).toContain('Still prose.')

	expect(
		find(
			[
				'~~~~md',
				'~~~',
				'Kody now supports fenced code.',
				'```',
				'~~~~',
				'Kody now supports prose.',
			].join('\n'),
		),
	).toEqual(kodyNowAt(6))

	const multiBacktick = [
		'Before ``code `x` Kody now supports hidden`` after.',
		'Kody now supports prose.',
	].join('\n')
	expect(stripMarkdownCode(multiBacktick).split('\n')[0]).toHaveLength(
		multiBacktick.split('\n')[0]?.length ?? 0,
	)
	expect(find(multiBacktick)).toEqual(kodyNowAt(2))

	expect(
		find(
			[
				'```md',
				'We no longer accept this sample.',
				'```',
				'',
				'Before `sample` Kody now supports packages.',
			].join('\n'),
		),
	).toEqual([
		expect.objectContaining({ line: 5, column: 17, pattern: 'Kody now' }),
		expect.objectContaining({
			line: 5,
			column: 22,
			pattern: nowSupportPattern,
		}),
	])

	expect(
		find(
			'Run the previous step, then use the current option. The audit previously mapped package ownership.',
		),
	).toEqual([])
})

test('flags every rollout prose pattern on the line it appears', () => {
	const cases: Array<[string, string]> = [
		['Now we reject invalid manifests.', 'now we'],
		['We now reject invalid manifests.', 'we now'],
		['We no longer accept legacy manifests.', 'we no longer'],
		['Kody now stores package state.', 'Kody now'],
		['Previously we stored package state elsewhere.', 'previously we'],
		['Formerly we stored package state elsewhere.', 'formerly we'],
		['The API no longer supports that option.', 'no longer support'],
		['Mutating writes no longer fan RPCs across buckets.', 'no longer support'],
		['Dormant sources no longer incur a HEAD lookup.', 'no longer support'],
		['D1 is no longer authoritative for enforcement.', 'no longer support'],
		['Callers no longer insert a D1 row on acquire.', 'no longer support'],
		['Confirm the columns are no longer needed.', 'no longer support'],
		['The API now supports this option.', 'now support'],
		['Point-read surfaces now call the meter helper.', 'now support'],
		['Internal USER product reads now pass through the helper.', 'now support'],
		['UserMeter is now the authoritative source.', 'is now a/the'],
		['The reconcile action is now a rollback-mirror repair.', 'is now a/the'],
		['Running services are now counted from the meter.', 'are now'],
		['Previously a best-effort shadow of D1.', 'previously a/the'],
		['This guide was recently updated.', 'recently changed'],
		['The API used to require that option.', 'used to support'],
		['Use the same restore-safe byte ceiling as before.', 'as before'],
		['Literal dynamic imports were removed.', 'were removed'],
		['Literal dynamic imports were **removed**.', 'were removed'],
		[
			'Legacy D1 workflow_runs was retired by migration 0137.',
			'was/were retired',
		],
		['The D1 mirror was dropped by migration 0126.', 'dropped by migration'],
		['Migration 0141 dropped the D1 leases table.', 'migration N dropped'],
		['Migration `0049` dropped the soak columns.', 'migration N dropped'],
		[
			'Post-cutover unrestorable exports never receive a manifest.',
			'post-cutover',
		],
		[
			'Post-squash, the follow-up migration renames stored tiers.',
			'post-squash',
		],
		['The guard now runs only for local applies.', 'now support'],
		['The helper now persists through that path.', 'now support'],
	]
	expect(
		cases.filter(
			([content, pattern]) =>
				!find(content).some(
					(match) =>
						match.file === 'docs/use/example.md' &&
						match.line === 1 &&
						match.pattern.includes(pattern),
				),
		),
	).toEqual([])
})

test('exempts principles and migration pages and scans discovered docs', async () => {
	expect(exemptRelativePrefixes).toContain('docs/contributing/decisions/')
	for (const relativePath of [
		...exemptRelativePaths,
		...exemptRelativePrefixes.map((prefix) => `${prefix}0001-example.md`),
	]) {
		expect(
			findTemporalLanguageMatches({
				relativePath,
				content: 'We no longer accept legacy manifests.',
			}),
		).toEqual([])
	}

	const cwd = await mkdtemp(path.join(os.tmpdir(), 'kody-docs-check-'))
	try {
		const files: Record<string, string> = {
			'README.md': 'Current behavior.\n',
			'AGENTS.md': 'Current behavior.\n',
			'docs/use/example.md': 'Kody now supports examples.\n',
			'.agents/skills/example/SKILL.md': 'Current behavior.\n',
			'packages/worker/src/mcp/server-instructions.ts':
				'export const instructions = "Current behavior."\n',
			'packages/worker/src/mcp/instructions/base-server-fragments.ts':
				'export const fragment = "Current behavior."\n',
		}
		for (const [file, content] of Object.entries(files)) {
			await mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
			await writeFile(path.join(cwd, file), content)
		}

		expect(await listDocumentationPaths(cwd)).toEqual([
			'.agents/skills/example/SKILL.md',
			'AGENTS.md',
			'README.md',
			'docs/use/example.md',
			'packages/worker/src/mcp/instructions/base-server-fragments.ts',
			'packages/worker/src/mcp/server-instructions.ts',
		])
		expect(await checkDocumentationTemporalLanguage(cwd)).toEqual(
			['Kody now', nowSupportPattern].map((pattern) =>
				expect.objectContaining({
					file: 'docs/use/example.md',
					line: 1,
					pattern,
				}),
			),
		)
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
