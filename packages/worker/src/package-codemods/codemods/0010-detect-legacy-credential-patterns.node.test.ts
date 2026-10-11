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
	).toEqual(['literal secret', 'packageSecrets.get'])

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
	).toEqual(['literal secret', 'computed secret', 'packageSecrets.get'])

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

test('0010 flags a computed |scope= suffix', () => {
	for (const source of [
		'export const p = (n: string, s: string) => `{{secret:${n}|scope=${s}}}`',
		"export const p = (s: string) => '{{secret:KEY|scope=' + s + '}}'",
		"export const p = (n: string, s: string) => '{{secret:' + n + '|scope=' + s + '}}'",
	]) {
		expect(modulePatterns(source)).toContain('|scope=')
	}
	expect(
		modulePatterns(
			'export default function broken( {\n\t`{{secret:KEY|scope=${s}}}`\n',
		),
	).toEqual(['computed secret', '|scope='])
	expect(
		modulePatterns(
			"export default function broken( {\n\t'{{secret:KEY|scope=' + s\n",
		),
	).toEqual(['computed secret', '|scope='])
	expect(
		modulePatterns("export const note = 'Use |scope=user for user secrets.'"),
	).toEqual(['|scope='])
	expect(
		modulePatterns("export const note = 'the |scope= suffix is retired'"),
	).toEqual([])
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

test('0010 ignores calls named after Object.prototype methods', () => {
	expect(
		modulePatterns(
			[
				'export const hex = (b: number) => b.toString(16)',
				"export const has = (o: object) => o.hasOwnProperty('k')",
				'export const value = (o: object) => o.valueOf()',
				"export const own = (o: object) => o.propertyIsEnumerable('k')",
				'export const proto = (o: object) => o.isPrototypeOf(o)',
				"export const local = (o: object) => o.toLocaleString('en')",
				"export const ctor = (o: object) => o.constructor('x')",
			].join('\n'),
		),
	).toEqual([])
})

const slotManifest = manifest({
	credentials: {
		cursorApiKey: {
			kind: 'secret',
			provider: 'cursor',
			description: 'Cursor API key.',
			placement: { header: 'Authorization', template: 'Bearer {value}' },
		},
		slack: { kind: 'oauth', provider: 'slack', description: 'Slack.' },
	},
})

test('0010 does not report references that name a declared slot of their kind', () => {
	const declared = (source: string) =>
		patternsByPath({ 'package.json': slotManifest, 'index.ts': source })[
			'index.ts'
		] ?? []
	expect(
		declared(
			[
				"import { createAuthenticatedFetch, kody, packageSecrets } from 'kody:runtime'",
				'export default async function run() {',
				"\tawait createAuthenticatedFetch('slack')",
				"\tawait kody.integrationTokenRefresh({ name: 'slack' })",
				"\tawait packageSecrets.has('cursorApiKey')",
				"\treturn fetch('https://x.test', { headers: { Authorization: 'Bearer {{secret:cursorApiKey}}', b: '{{integration-token:slack}}' } })",
				'}',
			].join('\n'),
		),
	).toEqual([])
	expect(
		declared("export const h = { Authorization: '{{secret:otherKey}}' }"),
	).toEqual(['literal secret'])
	expect(
		declared(
			"import { createAuthenticatedFetch } from 'kody:runtime'\nexport default () => createAuthenticatedFetch('cursorApiKey')",
		),
	).toEqual(['literal secret'])
	expect(
		declared(
			"export const h = { Authorization: 'Basic {{secret-basic:username=cursorApiKey,password=otherKey}}' }",
		),
	).toEqual(['literal secret'])
	expect(
		declared(
			"export const h = { Authorization: 'Bearer {{secret:cursorApiKey|scope=user}}' }",
		),
	).toEqual(['|scope='])
	expect(
		patternsByPath({
			'package.json': slotManifest,
			'index.ts':
				"export default function broken( {\n\tcreateAuthenticatedFetch('slack')\n\t'{{secret:cursorApiKey}}'",
		}),
	).toEqual({})
})

test('0010 resolves module-level string constants, including relative imports', () => {
	expect(
		modulePatterns(
			"const S = 'slack'; export const f = () => createAuthenticatedFetch(S)",
		),
	).toEqual(['literal secret'])
	expect(
		modulePatterns(
			"let S = 'slack'; export const f = () => createAuthenticatedFetch(S)",
		),
	).toEqual(['computed integration'])
	expect(
		patternsByPath({
			'package.json': slotManifest,
			'src/names.ts': [
				"export const SLACK_INTEGRATION = 'slack' as const",
				"const KEY = 'cursor' + 'ApiKey'",
				'export { KEY as CURSOR_KEY }',
			].join('\n'),
			'src/a.ts': [
				"import { createAuthenticatedFetch } from 'kody:runtime'",
				"import { CURSOR_KEY, SLACK_INTEGRATION } from './names.js'",
				'const AUTH = `Bearer {{secret:${CURSOR_KEY}}}`',
				'export default async () => {',
				'\tawait createAuthenticatedFetch(SLACK_INTEGRATION)',
				"\treturn fetch('https://x.test', { headers: { Authorization: AUTH, b: 'Bearer {{secret:' + CURSOR_KEY + '}}' } })",
				'}',
			].join('\n'),
		}),
	).toEqual({})
	expect(
		patternsByPath({
			'package.json': manifest(),
			'src/names.ts': "export const KEY = 'stripe'",
			'src/a.ts': [
				"import { KEY } from './names.ts'",
				"import { OTHER } from 'some-package'",
				"export const body = JSON.stringify({ k: '{{secret:' + KEY + '}}' })",
				'export const other = `{{secret:${OTHER}}}`',
			].join('\n'),
		})['src/a.ts'],
	).toEqual(['literal secret', 'computed secret', 'secret outside header'])
})

test('0010 ignores placeholder-shaped prose that names nothing', () => {
	expect(
		modulePatterns(
			[
				"export const r = (s: string) => s.replace(/x/g, '{{secret:<name>}}')",
				"export const redacted = '{{secret:…}}'",
				"export const help = JSON.stringify({ usage: 'Send {{integration-token:<integration>}} in a header.' })",
				"export const vault = 'Use {{secret/<provider>:<ref>}}.'",
			].join('\n'),
		),
	).toEqual([])
	expect(
		modulePatterns("export const f = (name) => '{{secret:' + name + '}}'"),
	).toEqual(['computed secret'])
})

test('0010 skips package test files', () => {
	const legacy = "export const h = { a: '{{secret:TOKEN}}' }"
	expect(
		patternsByPath({
			'package.json': manifest(),
			'src/a.test.ts': legacy,
			'src/a.spec.js': legacy,
			'src/__tests__/fixtures.ts': legacy,
			'src/latest.ts': legacy,
		}),
	).toEqual({ 'src/latest.ts': ['literal secret'] })
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
	).toEqual([
		'literal secret',
		'computed secret',
		'|scope=',
		'packageSecrets.get',
	])
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

test('0010 flags placeholders the gateway placement rule refuses', () => {
	const outside = [
		"fetch('https://api.telegram.org/bot{{secret:TOKEN}}/getMe')",
		'fetch(`https://x.test/search?key={{secret:KEY}}`)',
		"new Request(base + '?key={{secret:KEY}}')",
		"fetch('https://x.test', { method: 'POST', body: 'client_secret={{secret:S}}' })",
		"fetch('https://x.test', { body: JSON.stringify({ token: '{{secret:S}}' }) })",
		"new URLSearchParams({ token: '{{integration-token:github}}' })",
		"const url = 'https://x.test/{{secret/1password:op://v/i/f}}'",
	]
	for (const statement of outside) {
		expect(
			modulePatterns(`export default async () => {\n\t${statement}\n}`),
		).toContain('secret outside header')
	}
	const headerOrUnknown = [
		"fetch('https://x.test', { headers: { Authorization: 'Bearer {{secret:S}}' } })",
		"new Headers({ 'x-api-key': '{{secret:S}}' })",
		"fetch('https://x.test', { headers: { a: 'b' }, body: 'plain' })",
		"const auth = 'Bearer {{secret:S}}'",
		"fetch('https://x.test', { headers: { Referer: 'https://auth.test/{{secret:S}}' } })",
		"fetch('https://x.test', { headers: { 'x-meta': JSON.stringify({ t: '{{secret:S}}' }) } })",
	]
	for (const statement of headerOrUnknown) {
		expect(
			modulePatterns(`export default async () => {\n\t${statement}\n}`),
		).not.toContain('secret outside header')
	}
})

test('0010 flags plain http fetches in modules that use placeholders', () => {
	expect(
		modulePatterns(
			"export default () => fetch('http://api.example.com/v1', { headers: { Authorization: 'Bearer {{secret:S}}' } })",
		),
	).toContain('plain http')
	expect(
		modulePatterns("export default () => fetch('http://api.example.com/v1')"),
	).toEqual([])
	expect(
		modulePatterns(
			"export default () => fetch('https://api.example.com/v1', { headers: { Authorization: 'Bearer {{secret:S}}' } })",
		),
	).not.toContain('plain http')
})

test('0010 flags secret slots without placement', () => {
	expect(
		patternsByPath({
			'package.json': manifest({
				credentials: {
					KEY: { kind: 'secret', provider: 'acme', description: 'x' },
					GOOGLE: { kind: 'oauth', provider: 'google', description: 'x' },
				},
			}),
		}),
	).toEqual({ 'package.json': ['missing placement'] })
	expect(
		patternsByPath({
			'package.json': manifest({
				credentials: {
					KEY: {
						kind: 'secret',
						provider: 'acme',
						description: 'x',
						placement: { header: 'x-api-key' },
					},
				},
			}),
		}),
	).toEqual({})
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
