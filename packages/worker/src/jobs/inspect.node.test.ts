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

test('job inspect module stays off the job execution import graph', () => {
	const source = readFileSync(join(here, 'inspect.ts'), 'utf8')
	const specs = importSpecs(source)
	expect(specs).not.toEqual(
		expect.arrayContaining([
			expect.stringMatching(/run-kody-registry/),
			expect.stringMatching(/jobs\/service/),
			expect.stringMatching(/module-graph/),
			expect.stringMatching(/entitlements\/service/),
		]),
	)
	expect(specs).toContain('./manager-client.ts')
	expect(specs).toContain('./repo.ts')
})

test('job_list capability statically imports slim inspect, not service', () => {
	const source = readFileSync(
		join(here, '../mcp/capabilities/jobs/job-list.ts'),
		'utf8',
	)
	const specs = importSpecs(source)
	expect(specs).toContain('#worker/jobs/inspect.ts')
	expect(specs).not.toEqual(
		expect.arrayContaining([expect.stringMatching(/jobs\/service/)]),
	)
	expect(source).not.toMatch(/await import\s*\(/)
})

test('job_get capability statically imports slim inspect, not service', () => {
	const source = readFileSync(
		join(here, '../mcp/capabilities/jobs/job-get.ts'),
		'utf8',
	)
	const specs = importSpecs(source)
	expect(specs).toContain('#worker/jobs/inspect.ts')
	expect(specs).not.toEqual(
		expect.arrayContaining([expect.stringMatching(/jobs\/service/)]),
	)
})
