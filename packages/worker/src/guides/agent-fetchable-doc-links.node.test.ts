import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../..',
)

const blobUrlPattern = /github\.com\/[^/\s)'"]+\/[^/\s)'"]+\/blob\//

const rootedFiles = [
	'docs/use/README.md',
	'docs/use/what-can-kody-do.md',
	'packages/worker/src/mcp/tools/search-tool-definition.ts',
	'packages/worker/universal/onboarding-mcp-clients.ts',
	'packages/worker/src/app/agent-discovery.ts',
]

function markdownFiles(dir: string): Array<string> {
	const absolute = path.join(repoRoot, dir)
	return readdirSync(absolute).flatMap((name) => {
		const relative = path.join(dir, name)
		const absolutePath = path.join(repoRoot, relative)
		if (statSync(absolutePath).isDirectory()) return markdownFiles(relative)
		return name.endsWith('.md') ? [relative] : []
	})
}

test('agent-facing docs and tool descriptions use raw GitHub URLs', () => {
	const files = [
		...markdownFiles('docs/guides'),
		...markdownFiles('docs/use'),
		...rootedFiles,
	]
	const offenders: Array<string> = []
	for (const relative of files) {
		const text = readFileSync(path.join(repoRoot, relative), 'utf8')
		if (blobUrlPattern.test(text)) offenders.push(relative)
	}
	expect(offenders).toEqual([])
})
