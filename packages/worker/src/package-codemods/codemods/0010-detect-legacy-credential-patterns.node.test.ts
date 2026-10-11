import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	detectLegacyCredentialPatternsCodemod,
	legacyCredentialPatternFromMessage,
	legacyCredentialPatternMessages,
	legacyCredentialPatterns,
	type LegacyCredentialPattern,
} from './0010-detect-legacy-credential-patterns.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: { description: 'Demo package.', ...kody },
	})
}

function patternsByPath(files: Record<string, string>) {
	const result: Record<string, Array<LegacyCredentialPattern | null>> = {}
	for (const finding of detectLegacyCredentialPatternsCodemod.detect(
		files,
		packageContext,
	)) {
		const path = finding.path ?? ''
		result[path] ??= []
		result[path].push(legacyCredentialPatternFromMessage(finding.message))
	}
	return result
}

function modulePatterns(source: string) {
	return (
		patternsByPath({ 'package.json': manifest(), 'index.ts': source })[
			'index.ts'
		] ?? []
	)
}

test('0010 runs the example from package-codemods.md', () => {
	const doc = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../../../../docs/contributing/package-codemods.md',
		),
		'utf8',
	)
	const section = doc.split('### `0010-detect-legacy-credential-patterns`')[1]
	const example = section?.match(/```ts\n([\s\S]*?)```/)?.[1]
	expect(example).toBeDefined()
	expect(modulePatterns(example!)).toEqual([
		'literal secret',
		'computed secret',
		'computed integration',
		'kody.mcp',
		'|scope=',
	])
})

test('0010 tells literal names from computed ones', () => {
	expect(
		modulePatterns(
			[
				"import { createAuthenticatedFetch, packageSecrets, secretHeaders } from 'kody:runtime'",
				'export default async function run() {',
				"\tawait createAuthenticatedFetch('google')",
				"\tawait packageSecrets.get('stripe')",
				"\tsecretHeaders.basic({ usernameSecret: 'u', passwordSecret: 'p' })",
				"\treturn fetch('https://x.test', { headers: { a: '{{secret/1password:op://v/i/f}}', b: `{{integration-token:github}}` } })",
				'}',
			].join('\n'),
		),
	).toEqual(['literal secret'])

	expect(
		modulePatterns(
			[
				"import { packageSecrets, secretHeaders, oauthClientCredentials } from 'kody:runtime'",
				'export default async function run(name, opts) {',
				'\tawait packageSecrets.get(name)',
				'\tsecretHeaders.basic(opts)',
				"\tawait oauthClientCredentials({ tokenUrl: 'https://t.test', clientIdSecret: name, clientSecretSecret: 's' })",
				"\treturn '{{secret:' + name + '}}'",
				'}',
			].join('\n'),
		),
	).toEqual(['literal secret', 'computed secret'])

	expect(
		modulePatterns(
			[
				"import { createAuthenticatedFetch, kody } from 'kody:runtime'",
				'export default async function run(provider) {',
				'\tawait createAuthenticatedFetch(provider)',
				'\tawait kody.integrationTokenRefresh({ name: provider })',
				'\treturn `{{integration-token:${provider}}}`',
				'}',
			].join('\n'),
		),
	).toEqual(['computed integration'])
})

test('0010 finds kody.mcp through aliases, brackets, optional chains, and destructuring', () => {
	for (const source of [
		"import { kody as k } from 'kody:runtime'\nexport default () => k.mcp.home.tool({})",
		"import { kody } from 'kody:runtime'\nexport default () => kody['mcp']['home'].tool({})",
		"import { kody } from 'kody:runtime'\nexport default () => kody?.mcp?.home",
		"import { kody } from 'kody:runtime'\nconst { mcp } = kody\nexport default () => mcp.home",
	]) {
		expect(modulePatterns(source)).toEqual(['kody.mcp'])
	}
})

test('0010 flags scope options on secret helpers and the |scope= suffix', () => {
	expect(
		modulePatterns(
			[
				"import { kody, secretHeaders } from 'kody:runtime'",
				'export default async function run() {',
				"\tsecretHeaders.basic({ usernameSecret: 'u', passwordSecret: 'p', scope: 'package' })",
				"\treturn kody.secretJwtSign({ private_key_secret_name: 'k', private_key_secret_scope: 'session', algorithm: 'RS256', claims: {} })",
				'}',
			].join('\n'),
		),
	).toEqual(['literal secret', '|scope='])
})

test('0010 reads secretMounts and webhook secretName from package.json', () => {
	expect(
		patternsByPath({
			'package.json': manifest({
				secretMounts: { token: { name: 'token' } },
				webhooks: [
					{ name: 'plain', export: '.' },
					{
						name: 'sentry',
						export: '.',
						challenge: {
							type: 'subscription-challenge',
							prove: { kind: 'verify-token', secretName: 'verify' },
						},
					},
				],
			}),
		}),
	).toEqual({ 'package.json': ['secretMounts', 'webhook secretName'] })

	expect(
		patternsByPath({
			'package.json': manifest({
				webhooks: [
					{ name: 'github', export: '.', verification: { secretName: 's' } },
				],
			}),
		}),
	).toEqual({ 'package.json': ['webhook secretName'] })
})

test('0010 ignores comments, unrelated strings, Markdown, and clean manifests', () => {
	expect(
		patternsByPath({
			'package.json': manifest({
				credentials: {
					GOOGLE: { kind: 'oauth', provider: 'google', description: 'x' },
				},
				webhooks: [{ name: 'minted', export: '.' }],
			}),
			'README.md': 'Use `{{secret:TOKEN}}` and `kody.mcp`.',
			'index.ts': [
				"// await createAuthenticatedFetch('google')",
				'/* {{secret:TOKEN}} kody.mcp */',
				"const label = 'secret: not a placeholder'",
				'const basic = { basic: (x) => x }',
				"export default () => [label, basic.basic({ usernameSecret: 'u' }), fetch('https://x.test')]",
			].join('\n'),
		}),
	).toEqual({})
})

test('0010 falls back to text for unparseable modules', () => {
	expect(
		modulePatterns(
			[
				'export default function broken( {',
				"\tcreateAuthenticatedFetch('google')",
				'\tcreateAuthenticatedFetch(provider)',
				'\tkody.mcp.home',
				'\t`{{secret:${name}}}`',
			].join('\n'),
		),
	).toEqual([
		'literal secret',
		'computed secret',
		'computed integration',
		'kody.mcp',
	])

	expect(
		modulePatterns(
			[
				'export default function broken( {',
				'\tpackageSecrets.get(alias)',
				"\tsecretHeaders.basic({ usernameSecret: 'u', passwordSecret: p, scope: 'package' })",
			].join('\n'),
		),
	).toEqual(['literal secret', 'computed secret', '|scope='])
	expect(
		modulePatterns(
			'export default function broken( {\n\tkody.secretJwtSign(input)\n',
		),
	).toEqual(['computed secret'])
	expect(
		modulePatterns(
			"export default function broken( {\n\tkody.integrationTokenRefresh({ name: 'github' })\n",
		),
	).toEqual(['literal secret'])
})

test('0010 transform writes nothing and returns the findings as needsManual', () => {
	const files = {
		'package.json': manifest({ secretMounts: {} }),
		'index.ts': "export default () => '{{secret:TOKEN}}'",
	}
	const result = detectLegacyCredentialPatternsCodemod.transform(
		files,
		packageContext,
	)
	expect(result.changed).toBe(false)
	expect(result.changedPaths).toEqual([])
	expect(result.files).toBe(files)
	expect(result.needsManual).toEqual(
		detectLegacyCredentialPatternsCodemod.detect(files, packageContext),
	)
	expect(
		result.needsManual.map((finding) =>
			legacyCredentialPatternFromMessage(finding.message),
		),
	).toEqual(['literal secret', 'secretMounts'])
})

test('0010 finding messages are fixed and start with their pattern label', () => {
	const secretName = 'SUPER_PRIVATE_NAME'
	const findings = detectLegacyCredentialPatternsCodemod.detect(
		{
			'package.json': manifest(),
			'index.ts': `export default () => '{{secret:${secretName}}}'`,
		},
		packageContext,
	)
	expect(findings).toEqual([
		{
			path: 'index.ts',
			message: legacyCredentialPatternMessages['literal secret'],
		},
	])
	for (const pattern of legacyCredentialPatterns) {
		expect(legacyCredentialPatternMessages[pattern]).toMatch(
			new RegExp(`^${pattern.replace(/[.|]/g, '\\$&')}: `),
		)
	}
})
