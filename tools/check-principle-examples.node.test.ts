import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

const citedFences: ReadonlyArray<{
	page: string
	source: string
}> = [
	{
		page: 'docs/principles/generic-platform.md',
		source: 'packages/worker/src/package-registry/types.ts',
	},
	{
		page: 'docs/principles/normalized-source-of-truth.md',
		source:
			'packages/worker/src/package-invocations/subscription-topic-cache.ts',
	},
	{
		page: 'docs/principles/delete-off-the-common-path.md',
		source: 'packages/worker/src/package-registry/manifest.ts',
	},
	{
		page: 'docs/principles/cleanup.md',
		source: 'tools/check-docs-no-packages-invoke.ts',
	},
	{
		page: 'docs/principles/fail-loudly.md',
		source:
			'packages/worker/src/package-invocations/subscription-topic-cache.ts',
	},
	{
		page: 'docs/principles/two-way-doors.md',
		source:
			'packages/worker/src/package-runtime/published-runtime-artifacts.ts',
	},
]

function fencedTypeScript(markdown: string): Array<string> {
	const fences: Array<string> = []
	const pattern = /```ts\n([\s\S]*?)```/g
	for (const match of markdown.matchAll(pattern)) {
		const body = match[1]
		if (body) fences.push(body.replace(/\s+$/u, ''))
	}
	return fences
}

/** Indent in a markdown fence is not part of the source contract. */
function significantLines(value: string): string {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join('\n')
}

test.each(citedFences)(
	'$page code fence matches $source',
	async ({ page, source: sourcePath }) => {
		const pageText = await readFile(page, 'utf8')
		const source = await readFile(sourcePath, 'utf8')
		const fences = fencedTypeScript(pageText)
		expect(fences.length).toBeGreaterThan(0)
		const normalizedSource = significantLines(source)
		for (const fence of fences) {
			expect(normalizedSource).toContain(significantLines(fence))
		}
	},
)

test('examples-over-prose points at the local-execute sources and the checker', async () => {
	const page = await readFile('docs/principles/examples-over-prose.md', 'utf8')
	expect(page).toContain('guide:local_execute')
	expect(page).toContain('.agents/skills/prefer-local-cli-execute/SKILL.md')
	expect(page).toContain('docs:check-no-hosted-execute')
	expect(page).toContain('npx @kodycodes/cli execute --local')

	const rules = await readFile('tools/oxlint/oxlint-rules.json', 'utf8')
	const workflow = await readFile(
		'docs/principles/test-the-workflow.md',
		'utf8',
	)
	expect(workflow).toContain('kody-custom/no-tautological-absence')
	expect(rules).toContain('"kody-custom/no-tautological-absence"')
})
