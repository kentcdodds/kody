import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { toolCliEntryFiles } from './knip-tool-entries.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('shared tools helpers are not knip entries', () => {
	const entries = toolCliEntryFiles(repoRoot)
	expect(entries).not.toContain('tools/mcp-test-support.ts')
	expect(entries).not.toContain('tools/node-runtime.ts')
	expect(entries).not.toContain('tools/knip-tool-entries.ts')
	expect(entries).not.toContain(
		'tools/teams-migration/rewrite-api-token-scopes.ts',
	)
	expect(entries).not.toContain('tools/ensure-dev.ts')
	expect(entries).not.toContain('tools/ci/merge-conflict-check.ts')
	expect(entries).toContain('tools/preview-rehearsal/seal.ts')
	expect(entries).toContain('tools/memory-auto-surface-lab/run.mjs')
	expect(entries).toContain('tools/evals/package-discovery-routing.ts')
	expect(entries).toContain('tools/jobs-test-service.entry.ts')
	expect(entries).toContain('tools/highlight-test-service.entry.ts')
	expect(entries.length).toBeLessThan(160)
})

test('cli mains and node script targets are entries; helpers are not', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'knip-tool-entries-'))
	writeFixture(
		root,
		'package.json',
		JSON.stringify({
			scripts: {
				scripted:
					'node --env-file-if-exists=packages/worker/.env tools/from-script.ts',
				dynamic:
					'node --input-type=module -e "await import(\'./tools/dynamic.ts\')"',
			},
		}),
	)
	writeFixture(
		root,
		'.github/workflows/ci.yml',
		[
			'on:',
			'  workflow_dispatch:',
			'    inputs:',
			'      note:',
			'        description: node tools/described.ts',
			'jobs:',
			'  ci:',
			'    steps:',
			'      - run: |',
			'          echo "node tools/echoed.ts"',
			'          info="$(node tools/substituted.ts)"',
			'          node tools/ci/from-workflow.ts',
			'',
		].join('\n'),
	)
	writeFixture(
		root,
		'tools/described.ts',
		'if (isExecutedDirectly(import.meta.url)) {\n\tmain()\n}\n',
	)
	writeFixture(
		root,
		'tools/echoed.ts',
		'if (isExecutedDirectly(import.meta.url)) {\n\tmain()\n}\n',
	)
	writeFixture(
		root,
		'tools/substituted.ts',
		'if (isExecutedDirectly(import.meta.url)) {\n\tmain()\n}\n',
	)
	writeFixture(
		root,
		'tools/helper.ts',
		'export function helper() {}\n// isExecutedDirectly(import.meta.url)\n// node tools/mentioned.ts\n',
	)
	writeFixture(root, 'tools/mentioned.ts', 'export function mentioned() {}\n')
	writeFixture(
		root,
		'tools/runtime.ts',
		'export function isExecutedDirectly(importMetaUrl: string) {\n\treturn importMetaUrl\n}\n',
	)
	writeFixture(
		root,
		'tools/main.ts',
		'if (isExecutedDirectly(import.meta.url)) {\n\tmain()\n}\n',
	)
	writeFixture(root, 'tools/from-script.ts', 'export function run() {}\n')
	writeFixture(root, 'tools/dynamic.ts', 'export function dynamic() {}\n')
	writeFixture(root, 'tools/ci/from-workflow.ts', 'export {}\n')
	writeFixture(
		root,
		'tools/lab/run.mjs',
		'#!/usr/bin/env node\nconsole.log(1)\n',
	)
	writeFixture(
		root,
		'tools/evals/score.ts',
		'if (import.meta.url === pathToFileURL(process.argv[1]).href) {\n\trun()\n}\n',
	)
	writeFixture(
		root,
		'tools/helper.node.test.ts',
		'if (isExecutedDirectly(import.meta.url)) {}\n',
	)
	writeFixture(root, 'tools/worker.entry.ts', 'export default {}\n')
	writeFixture(
		root,
		'tools/build-worker.ts',
		"entryPoints: [path.join(root, 'tools/worker.entry.ts')]\n",
	)
	writeFixture(
		root,
		'packages/worker/migrations/0001.sql',
		'-- companion tools/repair.ts can re-run it\n',
	)
	writeFixture(root, 'tools/repair.ts', 'export function repair() {}\n')

	const entries = toolCliEntryFiles(root)
	expect(entries).not.toContain('tools/from-script.ts')
	expect(entries).not.toContain('tools/ci/from-workflow.ts')
	expect(entries).not.toContain('tools/substituted.ts')
	expect(entries).not.toContain('tools/repair.ts')
	expect(entries).not.toContain('tools/helper.ts')
	expect(entries).toEqual([
		'tools/described.ts',
		'tools/echoed.ts',
		'tools/evals/score.ts',
		'tools/lab/run.mjs',
		'tools/main.ts',
		'tools/worker.entry.ts',
	])
})

function writeFixture(root: string, relativePath: string, contents: string) {
	const absolutePath = path.join(root, relativePath)
	mkdirSync(path.dirname(absolutePath), { recursive: true })
	writeFileSync(absolutePath, contents)
}
