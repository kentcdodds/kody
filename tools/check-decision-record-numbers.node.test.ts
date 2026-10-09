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

test('decision record helpers reject duplicates, orphan labs, and heading mismatches', () => {
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

	const record = (filename: string) => {
		const classified = classifyDecisionRecordFilename(filename)
		if (!classified) throw new Error(`fixture ${filename} is not a record`)
		return classified
	}
	expect(
		findDuplicatePrimaryPrefixes([
			record('0022-retire-values-primitive.md'),
			record('0022-progressive-search-disclosure.md'),
			record('0033-memory-auto-surface-lab.md'),
		]),
	).toEqual([
		expect.stringContaining(
			'Duplicate decision number 0022: 0022-progressive-search-disclosure.md, 0022-retire-values-primitive.md',
		),
	])
	expect(
		findOrphanLabCompanions([record('0033-memory-auto-surface-lab.md')]),
	).toEqual([
		'Lab companion 0033-memory-auto-surface-lab.md has no primary 0033-*.md record.',
	])

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

async function decisionsTree(files: Record<string, string>) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'decision-record-numbers-'))
	const dir = path.join(cwd, 'docs', 'contributing', 'decisions')
	await mkdir(dir, { recursive: true })
	for (const [filename, content] of Object.entries(files)) {
		await writeFile(path.join(dir, filename), content)
	}
	return {
		cwd,
		[Symbol.asyncDispose]: () => rm(cwd, { recursive: true, force: true }),
	}
}

test('checkDecisionRecordNumbers accepts unique primaries and reports colliding primaries', async () => {
	{
		await using tree = await decisionsTree({
			'0000-template.md': '# NNNN: Short decision title\n',
			'0022-retire-values-primitive.md':
				'# 0022: Retire the values primitive\n',
			'0033-no-user-as-conversation.md': '# 0033: No user-as-conversation\n',
			'0033-memory-auto-surface-lab.md': '# 0033 lab: memory auto-surface\n',
			'index.md': [
				'- [0022 — Retire values](./0022-retire-values-primitive.md)',
				'- [0033 — No user-as-conversation](./0033-no-user-as-conversation.md)',
				'  ([lab](./0033-memory-auto-surface-lab.md))',
				'',
			].join('\n'),
		})
		await expect(checkDecisionRecordNumbers(tree.cwd)).resolves.toEqual({
			ok: true,
			errors: [],
		})
	}

	await using duplicates = await decisionsTree({
		'0022-retire-values-primitive.md': '# 0022: Retire the values primitive\n',
		'0022-progressive-search-disclosure.md':
			'# 0022: Progressive search disclosure\n',
		'index.md': '- list\n',
	})
	await expect(checkDecisionRecordNumbers(duplicates.cwd)).resolves.toEqual({
		ok: false,
		errors: [expect.stringContaining('Duplicate decision number 0022')],
	})
})
