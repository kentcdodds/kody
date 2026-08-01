import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function importSpecs(source: string) {
	return [
		...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g),
	].map((match) => match[1])
}

test('job list/get capabilities statically import slim inspect off the execution graph', () => {
	const inspectSource = readFileSync(join(here, 'inspect.ts'), 'utf8')
	const inspectSpecs = importSpecs(inspectSource)
	expect(inspectSpecs).not.toEqual(
		expect.arrayContaining([
			expect.stringMatching(/run-kody-registry/),
			expect.stringMatching(/jobs\/service/),
			expect.stringMatching(/module-graph/),
			expect.stringMatching(/entitlements\/service/),
		]),
	)
	expect(inspectSpecs).toContain('./manager-client.ts')
	expect(inspectSpecs).toContain('./repo.ts')
	expect(inspectSpecs).toContain('./job-run-observability-hydrate.ts')

	for (const relativePath of [
		'../mcp/capabilities/jobs/job-list.ts',
		'../mcp/capabilities/jobs/job-get.ts',
	]) {
		const source = readFileSync(join(here, relativePath), 'utf8')
		const specs = importSpecs(source)
		expect(specs).toContain('#worker/jobs/inspect.ts')
		expect(specs).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/jobs\/service/)]),
		)
		expect(source).not.toMatch(/await import\s*\(/)
	}
})
