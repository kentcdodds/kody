import { expect, test } from 'vitest'
import { legacyCredentialPatternMessages } from '../packages/worker/src/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import {
	buildCredentialPatternReport,
	collectScanItems,
	formatCredentialPatternReport,
} from './credential-pattern-report.ts'

const message = legacyCredentialPatternMessages

const steps = [
	{
		runId: 'run-1',
		items: [
			{
				userId: 'org-a',
				packageId: 'pkg-1',
				kodyId: 'calendar',
				status: 'detected',
				findings: [
					{ path: 'index.ts', message: message['literal secret'] },
					{ path: 'lib.ts', message: message['literal secret'] },
					{ path: 'index.ts', message: message['|scope='] },
				],
			},
			{
				userId: 'org-a',
				packageId: 'pkg-2',
				kodyId: 'clean',
				status: 'clean',
				findings: [],
			},
		],
	},
	{
		runId: 'run-1',
		items: [
			{
				userId: 'org-b',
				packageId: 'pkg-3',
				kodyId: 'hooks',
				status: 'detected',
				findings: [
					{ path: 'package.json', message: message['webhook secretName'] },
					{ path: 'index.ts', message: 'something else' },
				],
			},
			{
				userId: 'org-b',
				packageId: 'pkg-4',
				kodyId: 'draft',
				status: 'skipped_unpublished',
				findings: [],
			},
		],
	},
]

test('the report counts packages and files per pattern, per org, and per package', () => {
	const report = buildCredentialPatternReport(collectScanItems(steps))
	expect(report.packagesScanned).toBe(4)
	expect(report.statusCounts).toEqual({
		detected: 2,
		clean: 1,
		skipped_unpublished: 1,
	})
	expect(report.packagesByPattern['literal secret']).toBe(1)
	expect(report.findingsByPattern['literal secret']).toBe(2)
	expect(report.packagesByPattern['webhook secretName']).toBe(1)
	expect(report.packagesByPattern['kody.mcp']).toBe(0)
	expect(report.unknownFindings).toBe(1)
	expect(report.orgs).toEqual([
		{
			orgId: 'org-a',
			packages: 1,
			packagesByPattern: { 'literal secret': 1, '|scope=': 1 },
		},
		{
			orgId: 'org-b',
			packages: 1,
			packagesByPattern: { 'webhook secretName': 1 },
		},
	])
	expect(report.packages.map((row) => row.packageId)).toEqual([
		'pkg-1',
		'pkg-3',
	])

	const markdown = formatCredentialPatternReport(report)
	expect(markdown).toContain('| literal secret | 1 | 2 |')
	expect(markdown).toContain('| \\|scope= | 1 | 1 |')
	expect(markdown).toContain(
		'| org-a | pkg-1 | calendar | detected | 2 | 0 | 0 | 0 | 1 | 0 | 0 |',
	)
	expect(markdown).toContain('Findings with an unknown message: 1.')
})

test('a rescanned package counts once, using its latest item', () => {
	const report = buildCredentialPatternReport(
		collectScanItems([
			steps[0]!.items[0],
			{ ...steps[0]!.items[0], status: 'clean', findings: [] },
		]),
	)
	expect(report.packagesScanned).toBe(1)
	expect(report.packages).toEqual([])
	expect(report.statusCounts).toEqual({ clean: 1 })
})
