import { expect, test } from 'vitest'
import {
	sealCredentialStampsCodemod,
	sealCredentialStampsMessages,
} from './0014-seal-credential-stamps.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}, indent = '\t') {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './index.ts' },
			kody: { description: 'Demo package.', ...kody },
		},
		null,
		indent,
	)}\n`
}

function transform(source: string, kody: Record<string, unknown> = {}) {
	return sealCredentialStampsCodemod.transform(
		{ 'package.json': manifest(kody), 'index.ts': source },
		packageContext,
	)
}

function declaredSlots(result: { files: Record<string, string> }) {
	return JSON.parse(result.files['package.json']!).kody.credentials as Record<
		string,
		{ description: string; kind?: string }
	>
}

test('0014 seals literal credential(), MCP servers, and OAuth accounts with inferred descriptions', () => {
	const result = transform(
		[
			"import { credential, createAuthenticatedFetch, kody } from 'kody:runtime'",
			'export default async function run() {',
			'\tconst gh = await credential("GITHUB")',
			"\tconst google = await createAuthenticatedFetch('google')",
			'\tawait kody.mcp.linear.list_issues({})',
			"\treturn google('https://www.googleapis.com/calendar/v3/users/me')",
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		GITHUB: {
			description: 'Used by this package as credential "GITHUB".',
		},
		google: {
			kind: 'oauth',
			description: 'OAuth access for google.',
		},
		linear: {
			kind: 'mcp',
			description: 'Calls tools on the attached MCP server "linear".',
		},
	})
})

test('0014 never overwrites an existing description', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("API_KEY")',
			'}',
		].join('\n'),
		{
			credentials: {
				API_KEY: { description: 'Owner-written API key description.' },
			},
		},
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result).API_KEY).toEqual({
		description: 'Owner-written API key description.',
	})
})

test('0014 reports needs_manual for non-literal credential uses without changing files', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run(key: string) {',
			'\treturn credential(key)',
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([
		{
			path: 'index.ts',
			message: sealCredentialStampsMessages.unconvertible,
		},
	])
})

test('0014 detect is clean when the package has no credential uses', () => {
	const findings = sealCredentialStampsCodemod.detect(
		{
			'package.json': manifest(),
			'index.ts': 'export default async function run() { return 1 }',
		},
		packageContext,
	)
	expect(findings).toEqual([])
})
