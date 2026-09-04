#!/usr/bin/env node
// Upsert a system-recap block into a PR description without touching any
// text outside the markers. Usage:
//   node upsert-recap-block.mjs <pr-number> <block-file>
// The block file must start with the start marker and end with the end
// marker. Requires the `gh` CLI to be authenticated.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const startMarker = '<!-- system-recap:start -->'
const endMarker = '<!-- system-recap:end -->'
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

const [prNumber, blockFile] = process.argv.slice(2)
if (!prNumber || !blockFile) {
	console.error('usage: upsert-recap-block.mjs <pr-number> <block-file>')
	process.exit(1)
}

const block = readFileSync(blockFile, 'utf8').trim()
if (!block.startsWith(startMarker) || !block.endsWith(endMarker)) {
	console.error(
		`block file must start with "${startMarker}" and end with "${endMarker}"`,
	)
	process.exit(1)
}

const mermaidCheck = spawnSync(
	process.execPath,
	[
		path.join(repoRoot, 'tools/check-mermaid-syntax.ts'),
		'--stdin',
		'--label',
		blockFile,
	],
	{ input: block, encoding: 'utf8', cwd: repoRoot },
)
if (mermaidCheck.status !== 0) {
	process.stderr.write(mermaidCheck.stdout)
	process.stderr.write(mermaidCheck.stderr)
	process.exit(mermaidCheck.status === null ? 1 : mermaidCheck.status)
}

const body = execFileSync(
	'gh',
	['pr', 'view', prNumber, '--json', 'body', '--jq', '.body'],
	{ encoding: 'utf8' },
)

const startIndex = body.indexOf(startMarker)
const endIndex = body.indexOf(endMarker)
const hasExistingBlock =
	startIndex !== -1 && endIndex !== -1 && endIndex > startIndex

const nextBody = hasExistingBlock
	? body.slice(0, startIndex) + block + body.slice(endIndex + endMarker.length)
	: `${body.trimEnd()}\n\n${block}\n`

execFileSync('gh', ['pr', 'edit', prNumber, '--body-file', '-'], {
	input: nextBody,
})

console.log(
	hasExistingBlock
		? `updated system-recap block on PR #${prNumber}`
		: `added system-recap block to PR #${prNumber}`,
)
