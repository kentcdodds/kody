import { expect, test } from 'vitest'
import {
	buildPackageAgentsDetail,
	formatRequiredPackageDocsFailure,
	listMissingRequiredPackageDocs,
	validateRequiredPackageDocs,
} from './package-docs.ts'

const humanReadme = `# Demo

## Intent

Help a human set this up.

## Prerequisites

A Kody account.

## Setup

Install the package, then connect the provider.

## Done when

The default export returns ok.
`

const agentNotes = `# Agent notes

## Imports

import demo from 'kody:@scope/demo'

## Smoke tests

Call the default export from execute after publish.

## Edge cases

Missing provider auth should throw.
`

test('validateRequiredPackageDocs requires non-empty README.md and AGENTS.md', () => {
	expect(
		validateRequiredPackageDocs({
			'package.json': '{}',
			'README.md': humanReadme,
			'AGENTS.md': agentNotes,
		}),
	).toEqual({
		ok: true,
		message: 'Found non-empty root README.md and AGENTS.md.',
	})

	expect(
		listMissingRequiredPackageDocs({
			'readme.md': humanReadme,
			'agents.md': agentNotes,
			'AGENTS.md': '   \n',
			'README.md': '',
		}),
	).toEqual(['README.md', 'AGENTS.md'])

	const missingAgents = validateRequiredPackageDocs({
		'README.md': humanReadme,
	})
	expect(missingAgents.ok).toBe(false)
	expect(missingAgents.message).toBe(
		formatRequiredPackageDocsFailure(['AGENTS.md']),
	)
	expect(missingAgents.message).toContain('human setup')
	expect(missingAgents.message).toContain('agent notes')
	expect(missingAgents.message).toContain('"AGENTS.md"')

	const missingBoth = validateRequiredPackageDocs({})
	expect(missingBoth.ok).toBe(false)
	expect(missingBoth.message).toBe(
		formatRequiredPackageDocsFailure(['README.md', 'AGENTS.md']),
	)
})

test('buildPackageAgentsDetail returns the root AGENTS.md body', () => {
	expect(
		buildPackageAgentsDetail({
			files: {
				'README.md': humanReadme,
				'AGENTS.md': agentNotes,
			},
		}),
	).toEqual({
		path: 'AGENTS.md',
		content: agentNotes.trim(),
		truncated: false,
	})
	expect(
		buildPackageAgentsDetail({
			files: {
				'AGENTS.md': `${'x'.repeat(80)}\n`,
			},
			maxChars: 20,
		}),
	).toEqual({
		path: 'AGENTS.md',
		content: `${'x'.repeat(19)}…`,
		truncated: true,
	})
	expect(
		buildPackageAgentsDetail({ files: { 'README.md': humanReadme } }),
	).toBe(null)
})
