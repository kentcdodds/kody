#!/usr/bin/env node
// Upsert a system-recap block into a PR description without touching any
// text outside the markers. Usage:
//   node upsert-recap-block.mjs <pr-number> <block-file>
// The block file must start with the start marker and end with the end
// marker. Requires the `gh` CLI to be authenticated.
//
// Cloud Agents cannot `gh pr edit` (GraphQL updatePullRequest is forbidden
// for the integration token). On that failure the script still validates
// mermaid, prints the merged body, and tells the agent to apply it with
// Cursor ManagePullRequest.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const startMarker = '<!-- system-recap:start -->'
const endMarker = '<!-- system-recap:end -->'
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

export function isGhPrEditForbidden(error) {
	const text =
		error instanceof Error
			? `${error.message}${
					'stderr' in error && typeof error.stderr === 'string'
						? error.stderr
						: ''
				}`
			: String(error)
	return (
		text.includes('Resource not accessible by integration') ||
		text.includes('updatePullRequest')
	)
}

export function mergeRecapBody(body, block) {
	const startIndex = body.indexOf(startMarker)
	const endIndex = body.indexOf(endMarker)
	const hasExistingBlock =
		startIndex !== -1 && endIndex !== -1 && endIndex > startIndex
	const nextBody = hasExistingBlock
		? body.slice(0, startIndex) +
			block +
			body.slice(endIndex + endMarker.length)
		: `${body.trimEnd()}\n\n${block}\n`
	return { hasExistingBlock, nextBody }
}

function main() {
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

	const { hasExistingBlock, nextBody } = mergeRecapBody(body, block)

	try {
		execFileSync('gh', ['pr', 'edit', prNumber, '--body-file', '-'], {
			input: nextBody,
		})
	} catch (error) {
		if (isGhPrEditForbidden(error)) {
			console.error(
				`gh pr edit cannot update PR #${prNumber} (Resource not accessible by integration). Cloud Agents must apply this recap with Cursor ManagePullRequest. Merged PR body follows.`,
			)
			process.stdout.write(nextBody)
			if (!nextBody.endsWith('\n')) process.stdout.write('\n')
			process.exitCode = 2
			return
		}
		throw error
	}

	console.log(
		hasExistingBlock
			? `updated system-recap block on PR #${prNumber}`
			: `added system-recap block to PR #${prNumber}`,
	)
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	main()
}
