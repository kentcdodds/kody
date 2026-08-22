import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkDecisionRecordNumbers,
	classifyDecisionRecordFilename,
	findDuplicatePrimaryPrefixes,
	findFirstMarkdownHeading,
	findHeadingPrefixMismatches,
	findIndexPrimaryNumberCollisions,
	findOrphanLabCompanions,
} from './check-decision-record-numbers.ts'

test('classifyDecisionRecordFilename treats lab companions as non-primary', () => {
	expect(
		classifyDecisionRecordFilename('0022-retire-values-primitive.md'),
	).toEqual({
		filename: '0022-retire-values-primitive.md',
		prefix: '0022',
		slug: 'retire-values-primitive',
		kind: 'primary',
	})
	expect(
		classifyDecisionRecordFilename('0033-memory-auto-surface-lab.md'),
	).toEqual({
		filename: '0033-memory-auto-surface-lab.md',
		prefix: '0033',
		slug: 'memory-auto-surface-lab',
		kind: 'lab',
	})
	expect(classifyDecisionRecordFilename('0000-template.md')).toBeNull()
	expect(classifyDecisionRecordFilename('index.md')).toBeNull()
})

test('duplicate primary prefixes and orphan labs are rejected', () => {
	expect(
		findDuplicatePrimaryPrefixes([
			{
				filename: '0022-retire-values-primitive.md',
				prefix: '0022',
				slug: 'retire-values-primitive',
				kind: 'primary',
			},
			{
				filename: '0022-progressive-search-disclosure.md',
				prefix: '0022',
				slug: 'progressive-search-disclosure',
				kind: 'primary',
			},
			{
				filename: '0033-memory-auto-surface-lab.md',
				prefix: '0033',
				slug: 'memory-auto-surface-lab',
				kind: 'lab',
			},
		]),
	).toEqual([
		expect.stringContaining(
			'Duplicate decision number 0022: 0022-progressive-search-disclosure.md, 0022-retire-values-primitive.md',
		),
	])
	expect(
		findOrphanLabCompanions([
			{
				filename: '0033-memory-auto-surface-lab.md',
				prefix: '0033',
				slug: 'memory-auto-surface-lab',
				kind: 'lab',
			},
		]),
	).toEqual([
		'Lab companion 0033-memory-auto-surface-lab.md has no primary 0033-*.md record.',
	])
})

test('heading prefix must match the filename number', () => {
	expect(
		findHeadingPrefixMismatches({
			filename:
				'docs/contributing/decisions/0023-progressive-search-disclosure.md',
			prefix: '0023',
			content: '# 0022: Progressive search disclosure\n',
		}),
	).toEqual([
		'docs/contributing/decisions/0023-progressive-search-disclosure.md heading number 0022 does not match filename prefix 0023.',
	])
	expect(
		findHeadingPrefixMismatches({
			filename: 'docs/contributing/decisions/0033-memory-auto-surface-lab.md',
			prefix: '0033',
			content: '# 0033 lab: memory auto-surface\n',
		}),
	).toEqual([])
})

test('heading detection ignores fenced # lines', () => {
	expect(
		findFirstMarkdownHeading(`
\`\`\`md
# 0023: Example in a fence
\`\`\`

# 0022: Real heading
`),
	).toBe('# 0022: Real heading')
	expect(
		findHeadingPrefixMismatches({
			filename: 'docs/contributing/decisions/0022-retire-values-primitive.md',
			prefix: '0022',
			content: [
				'```md',
				'# 0023: Example in a fence',
				'```',
				'',
				'# 0022: Retire the values primitive',
				'',
			].join('\n'),
		}),
	).toEqual([])
	expect(
		findFirstMarkdownHeading(
			[
				'````md',
				'```',
				'# 0023: Inside a longer fence',
				'```',
				'````',
				'',
				'# 0022: Real heading',
			].join('\n'),
		),
	).toBe('# 0022: Real heading')
})

test('index collisions ignore lab companion links', () => {
	expect(
		findIndexPrimaryNumberCollisions(`
- [0022 — Retire values](./0022-retire-values-primitive.md)
- [0022 — Progressive search](./0022-progressive-search-disclosure.md)
- [0033 — No user-as-conversation](./0033-no-user-as-conversation.md)
  ([lab](./0033-memory-auto-surface-lab.md))
`),
	).toEqual([
		expect.stringContaining(
			'links two primary records as 0022: 0022-progressive-search-disclosure.md, 0022-retire-values-primitive.md',
		),
	])
})

test('checkDecisionRecordNumbers accepts unique primaries plus a lab companion', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'decision-record-numbers-'))
	const decisionsDir = path.join(cwd, 'docs', 'contributing', 'decisions')
	try {
		await mkdir(decisionsDir, { recursive: true })
		await Promise.all([
			writeFile(
				path.join(decisionsDir, '0000-template.md'),
				'# NNNN: Short decision title\n',
			),
			writeFile(
				path.join(decisionsDir, '0022-retire-values-primitive.md'),
				'# 0022: Retire the values primitive\n',
			),
			writeFile(
				path.join(decisionsDir, '0033-no-user-as-conversation.md'),
				'# 0033: No user-as-conversation\n',
			),
			writeFile(
				path.join(decisionsDir, '0033-memory-auto-surface-lab.md'),
				'# 0033 lab: memory auto-surface\n',
			),
			writeFile(
				path.join(decisionsDir, 'index.md'),
				[
					'- [0022 — Retire values](./0022-retire-values-primitive.md)',
					'- [0033 — No user-as-conversation](./0033-no-user-as-conversation.md)',
					'  ([lab](./0033-memory-auto-surface-lab.md))',
					'',
				].join('\n'),
			),
		])
		await expect(checkDecisionRecordNumbers(cwd)).resolves.toEqual({
			ok: true,
			errors: [],
		})
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})

test('checkDecisionRecordNumbers reports colliding primaries on disk', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'decision-record-dup-'))
	const decisionsDir = path.join(cwd, 'docs', 'contributing', 'decisions')
	try {
		await mkdir(decisionsDir, { recursive: true })
		await Promise.all([
			writeFile(
				path.join(decisionsDir, '0022-retire-values-primitive.md'),
				'# 0022: Retire the values primitive\n',
			),
			writeFile(
				path.join(decisionsDir, '0022-progressive-search-disclosure.md'),
				'# 0022: Progressive search disclosure\n',
			),
			writeFile(path.join(decisionsDir, 'index.md'), '- list\n'),
		])
		const result = await checkDecisionRecordNumbers(cwd)
		expect(result.ok).toBe(false)
		expect(result.errors).toEqual([
			expect.stringContaining('Duplicate decision number 0022'),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
